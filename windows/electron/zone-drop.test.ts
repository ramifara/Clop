import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { graphic } from '../core/media/image.fixtures';
import { OptimisedMarker } from '../core/marker';
import { seedBuiltinPipelines } from '../core/pipeline/builtins';
import { decodePipelines, decodePresetZones } from '../core/pipeline/codec';
import { FakeEffects } from '../core/pipeline/executor.fixtures';
import { referenceTo, type Pipeline, type PresetZone } from '../core/pipeline/model';
import { parseSteps } from '../core/pipeline/parser';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { SettingsStore } from '../core/settings/store';
import { needTools } from '../core/testing';
import { Workdir } from '../core/workdir';
import { mediaKind } from './clipboard';
import { EditorService } from './editor';
import { ItemEngine } from './items';
import type { PipelineHost } from './pipelines';
import { dropRunsPipelines, planZoneDrop, zoneAutomation, zoneSkipsOptimisation, type ZoneDropSettings } from './zone-drop';

const balanced = { mode: 'balanced', format: 'auto', scale: 1 } as const;
const pipeline = (id: string, text: string, extra: Partial<Pipeline> = {}): Pipeline => ({ id, name: id, steps: parseSteps(text), rawText: text, skipOptimisation: false, hideResult: false, ...extra });
const zone = (id: string, type: PresetZone['type'], runs: Pipeline): PresetZone => ({ id, name: id, icon: 'photo', type, pipeline: runs });
const WEBP = pipeline('WEBP', 'convert(to: webp)', { fileType: 'image', skipOptimisation: true });
const HALF = pipeline('HALF', 'downscale(factor: 0.5)');
const kindOf = mediaKind;
const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');

async function tree(t: TestContext, files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-zone-drop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}
const names = (files: string[]) => files.map(file => path.basename(file));

test('a folder dropped on a zone becomes the files inside it, with dropped files, recursively and by .clopignore', async t => {
  const dir = await tree(t, { 'pics/a.png': 'a', 'pics/sub/b.jpg': 'b', 'pics/.hidden.png': 'h', 'pics/.clopignore-image': 'raw/\n', 'pics/raw/r.png': 'r', 'single.png': 's' });
  const settings: ZoneDropSettings = { presetZones: [zone('ANY', undefined, HALF)], savedPipelines: [] };
  const plan = await planZoneDrop(settings, 'ANY', [path.join(dir, 'single.png'), path.join(dir, 'pics')], { kindOf });
  assert.deepEqual([names(plan.files), plan.notice], [['single.png', 'a.png', 'b.jpg'], undefined]);
});

test('a typed zone skips files of other types with one notice saying how many and why; an untyped zone takes every type', async t => {
  const dir = await tree(t, { 'mixed/a.png': 'a', 'mixed/b.mp4': 'b', 'mixed/c.mp3': 'c', 'd.pdf': 'd', 'e.jpg': 'e' });
  const drop = [path.join(dir, 'mixed'), path.join(dir, 'd.pdf'), path.join(dir, 'e.jpg')];
  const typed: ZoneDropSettings = { presetZones: [zone('Shrink', 'image', HALF)], savedPipelines: [] };
  const plan = await planZoneDrop(typed, 'Shrink', drop, { kindOf });
  assert.deepEqual(names(plan.files).sort(), ['a.png', 'e.jpg']);
  assert.equal(plan.notice, 'Shrink runs on image files only, so 3 files of other types were skipped.');
  // An untyped zone running a pipeline for one type (as macOS can store it) takes that type only.
  const typedPipeline: ZoneDropSettings = { presetZones: [zone('Any', undefined, WEBP)], savedPipelines: [] };
  assert.match((await planZoneDrop(typedPipeline, 'Any', [path.join(dir, 'e.jpg'), path.join(dir, 'd.pdf')], { kindOf })).notice!, /^Any runs on image files only, so 1 file of another type was skipped\.$/);
  const any: ZoneDropSettings = { presetZones: [zone('All', undefined, HALF)], savedPipelines: [] };
  const all = await planZoneDrop(any, 'All', drop, { kindOf });
  assert.deepEqual([all.files.length, all.notice], [5, undefined]);
  const empty = await tree(t, { 'nothing/readme.txt': 'r' });
  assert.equal((await planZoneDrop(any, 'All', [path.join(empty, 'nothing')], { kindOf })).notice, 'nothing: no images, videos, audio or PDFs to optimise.');
});

test('a zone that cannot run refuses the drop with a clear message instead of optimising plainly', async () => {
  const unreadable = decodePipelines([{ id: 'FUTURE', name: 'Future', steps: [{ teleport: {} }] }])!;
  const settings: ZoneDropSettings = {
    presetZones: [zone('Deleted', 'image', referenceTo(pipeline('GONE', 'optimise'))), zone('Unreadable', 'image', { ...referenceTo(HALF), libraryID: 'FUTURE' }), zone('Empty', 'image', pipeline('E', ''))],
    savedPipelines: [HALF, ...unreadable],
  };
  const plan = (id: unknown) => planZoneDrop(settings, id, [], { kindOf });
  await assert.rejects(plan('Deleted'), /The pipeline Deleted ran was deleted, so nothing was optimised\. Choose another one in the pipeline editor\./);
  await assert.rejects(plan('Unreadable'), /Unreadable runs a pipeline this version of Clop cannot read \(.*teleport.*\), so nothing was optimised/);
  await assert.rejects(plan('Empty'), /Empty has no pipeline to run/);
  await assert.rejects(plan('Nope'), /no longer exists/);
  await assert.rejects(planZoneDrop({ ...settings, presetZones: [zone('OK', 'image', HALF)] }, 'OK', 'C:\\a.png', { kindOf }), /Drop files or folders/);
});

test('Shift skips the drop zone\'s attached pipelines but never a preset zone\'s', () => {
  assert.equal(dropRunsPipelines({ aggressive: false }), true);
  assert.equal(dropRunsPipelines({ aggressive: true }), false, 'an aggressive drop on the drop zone is a plain aggressive optimisation (wantsPipelineLookup)');
  assert.equal(dropRunsPipelines({ aggressive: true, zone: 'Z' }), true, 'Shift on a preset zone still runs its pipeline');
  assert.equal(dropRunsPipelines({ aggressive: false, zone: 'Z' }), true);
});

// What the main process does with a drop on a zone (`zoneDropped` and `importFiles` in main.ts): plan it, then import every file as a
// drop whose automation is the zone's pipeline for the kind the file turns out to be, optimised aggressively with Shift.
async function setup(t: TestContext) {
  if (!needTools(t, 'pngquant')) return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'clop-zone-drop-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workdir = await new Workdir(path.join(root, 'work')).ensure(), marker = new OptimisedMarker(path.join(root, 'optimised.json'));
  const state = { settings: defaultSettings() as ClopSettings };
  const host: PipelineHost = { env: () => ({ settings: state.settings, workdir, marker, counter: { value: 0 } }), effects: () => new FakeEffects(), counterChanged: () => {}, keep: () => {} };
  const engine = new ItemEngine(path.join(workdir.temp, 'session'), () => state.settings);
  const folder = async (name: string, files: string[]) => {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    for (const [i, file] of files.entries()) await graphic(400 + i * 20, 240).png({ compressionLevel: 0 }).toFile(path.join(dir, file));
    return dir;
  };
  async function drop(settings: ZoneDropSettings, id: string, files: string[], aggressive = false) {
    const plan = await planZoneDrop(settings, id, files, { kindOf });
    const ids: string[] = [];
    for (const file of plan.files) {
      ids.push(await engine.importPath(file, 'drop', aggressive ? { ...balanced, mode: 'aggressive' } : balanced, undefined, dropRunsPipelines({ aggressive, zone: id }) ? {
        late: kind => ({ automation: zoneAutomation(settings, id, kind, { host }) }),
      } : {}));
    }
    return { plan, results: ids.map(id => ({ ...engine.get(id).result, output: engine.output(id) })) };
  }
  return { root, engine, host, folder, drop };
}

test('a folder dropped on a zone running a library pipeline converts every file in it, leaves the originals alone, and restores', async t => {
  const f = await setup(t); if (!f) return;
  const dir = await f.folder('Two photos', ['first.png', 'second.png']);
  const originals = await Promise.all(['first.png', 'second.png'].map(name => hash(path.join(dir, name))));
  const settings: ZoneDropSettings = { presetZones: [zone('To WebP', 'image', referenceTo(WEBP))], savedPipelines: [WEBP] };
  const { results } = await f.drop(settings, 'To WebP', [dir]);
  assert.deepEqual(results.map(r => [r.name, r.status, r.format, r.source, path.extname(r.output)]), [['first.png', 'ready', 'webp', 'drop', '.webp'], ['second.png', 'ready', 'webp', 'drop', '.webp']]);
  for (const r of results) assert.equal((await sharp(r.output).metadata()).format, 'webp');
  assert.deepEqual(await Promise.all(['first.png', 'second.png'].map(name => hash(path.join(dir, name)))), originals, 'the dropped files are never written to');
  await f.engine.restore(results[0].id);
  assert.deepEqual([path.extname(f.engine.output(results[0].id)), f.engine.get(results[0].id).result.restored], ['.png', true], 'Restore gives back the original');
});

test('an inline pipeline and a pipeline stored as text only run on a zone; one that does not encode follows the usual optimisation', async t => {
  const f = await setup(t); if (!f) return;
  const dir = await f.folder('Shots', ['a.png']);
  // As the settings file stores it: no steps, only the text the user wrote.
  const [textOnly] = decodePresetZones([{ id: 'Text', name: 'Text', icon: 'photo', type: 'image', pipeline: { id: 'T', rawText: 'convert(to: webp)', skipOptimisation: true } }]) as PresetZone[];
  assert.equal(textOnly.pipeline.steps.length, 1, 'the text is read into steps');
  const settings: ZoneDropSettings = { presetZones: [textOnly, zone('Inline', undefined, pipeline('I', 'copyToClipboard'))], savedPipelines: [] };
  const [converted] = (await f.drop(settings, 'Text', [path.join(dir, 'a.png')])).results;
  assert.deepEqual([converted.status, converted.format], ['ready', 'webp']);
  // A pipeline that does not skip optimisation runs on the optimised file, aggressive with Shift.
  assert.equal(zoneSkipsOptimisation((settings.presetZones[1] as PresetZone).pipeline), false);
  const [optimised] = (await f.drop(settings, 'Inline', [path.join(dir, 'a.png')], true)).results;
  assert.deepEqual([optimised.status, optimised.format, optimised.options.mode], ['ready', 'png', 'aggressive'], optimised.error);
  assert.ok(optimised.outputBytes < optimised.originalBytes, 'optimised before the pipeline ran');
});

test('Shift on a zone whose pipeline converts still converts: the pipeline runs and the drop is aggressive', async t => {
  const f = await setup(t); if (!f) return;
  const dir = await f.folder('Shift', ['a.png', 'b.png']);
  const settings: ZoneDropSettings = { presetZones: [zone('W', 'image', WEBP)], savedPipelines: [] };
  const { results } = await f.drop(settings, 'W', [dir], true);
  assert.deepEqual(results.map(r => [r.status, r.format, r.options.mode]), [['ready', 'webp', 'aggressive'], ['ready', 'webp', 'aggressive']]);
});

test('a zone\'s pipeline that encodes the file anywhere starts from the dropped file, not from an optimised copy (skipOptimiseAndRunPipelineIfEncoding)', async t => {
  for (const text of ['optimise(encoder: lossless)', 'copyToClipboard -> stripExif', 'if(nameContains: "a") -> watermark(image: "w.png")', 'convert(to: webp)']) assert.equal(zoneSkipsOptimisation(pipeline('P', text)), true, text);
  for (const text of ['copyToClipboard', 'removeAudio', 'rename(to: "%f-small")']) assert.equal(zoneSkipsOptimisation(pipeline('P', text)), false, text);
  assert.equal(zoneSkipsOptimisation(pipeline('P', 'copyToClipboard', { skipOptimisation: true })), true);
  const f = await setup(t); if (!f) return;
  const source = path.join(await f.folder('Encoding', ['a.png']), 'a.png');
  const settings: ZoneDropSettings = { presetZones: [zone('Encodes', 'image', pipeline('E', 'copyToClipboard -> optimise(encoder: aggressive)')), zone('Copies', 'image', pipeline('C', 'copyToClipboard'))], savedPipelines: [] };
  /** Whether the zone's pipeline was handed Clop's optimised file rather than a copy of the dropped one. */
  async function startsOptimised(id: string) {
    const automation = zoneAutomation(settings, id, 'image', { host: f!.host }), run = automation.run;
    let optimised: string | undefined;
    automation.run = async input => { optimised = input.optimised; return run(input); };
    const item = await f!.engine.importPath(source, 'drop', balanced, undefined, { automation });
    assert.equal(f!.engine.get(item).result.status, 'ready', f!.engine.get(item).result.error);
    return optimised !== undefined;
  }
  assert.equal(await startsOptimised('Encodes'), false, 'a pipeline that optimises does not get an optimised file to optimise again');
  assert.equal(await startsOptimised('Copies'), true, 'one that does not encode runs after the usual optimisation');
});

test('a pipeline made in the editor and set as a zone while the app runs is used by the next drop, with no restart', async t => {
  const f = await setup(t); if (!f) return;
  const file = path.join(f.root, 'settings.json'), store = new SettingsStore(file, { home: f.root, desktop: f.root, userData: f.root }, true);
  let settings = await store.load();
  settings = (await store.update(current => ({ patch: seedBuiltinPipelines(current.savedPipelines, current.builtinPipelinesSeededVersion), result: undefined }))).settings;
  // As in main.ts: the app keeps the latest settings the store reports.
  store.on('change', next => { settings = next; });
  const editor = new EditorService({ settings: () => store.get(), update: change => store.update(change), context: () => ({ home: f.root }) });
  const dir = await f.folder('Live', ['a.png']);
  await assert.rejects(f.drop(settings, 'Half', [dir]), /no longer exists/);
  const made = await editor.command({ type: 'pipeline-save', name: 'Half size', fileType: 'image', skipOptimisation: false, hideResult: false, view: 'text', text: 'downscale(factor: 0.5)' });
  assert.ok(made.saved, JSON.stringify(made.issues));
  const zoned = await editor.command({ type: 'zone-save', name: 'Half', icon: 'photo', fileType: 'image', pipelineId: made.saved });
  assert.equal(zoned.issues, undefined);
  const id = (settings.presetZones as PresetZone[]).find(entry => entry.name === 'Half')!.id;
  const [result] = (await f.drop(settings, id, [dir])).results;
  assert.deepEqual([result.status, result.width, result.height], ['ready', 200, 120], result.error);
  // Changed in the editor, the zone's pipeline is the new one at the next drop.
  const view = editor.state().library.find(entry => entry.key === made.saved)!;
  await editor.command({ type: 'pipeline-save', id: made.saved, base: view.revision, name: 'Half size', fileType: 'image', skipOptimisation: true, hideResult: false, view: 'text', text: 'convert(to: webp)' });
  const [again] = (await f.drop(settings, id, [dir])).results;
  assert.deepEqual([again.status, again.format], ['ready', 'webp'], again.error);
});
