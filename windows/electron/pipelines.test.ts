import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { graphic, photo } from '../core/media/image.fixtures';
import { clip } from '../core/media/video.fixtures';
import { OptimisedMarker } from '../core/marker';
import { decodePipelines } from '../core/pipeline/codec';
import { FakeEffects } from '../core/pipeline/executor.fixtures';
import { referenceTo, type Pipeline } from '../core/pipeline/model';
import { parseSteps } from '../core/pipeline/parser';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { needTools } from '../core/testing';
import { Workdir } from '../core/workdir';
import type { AppEntry } from '../src/types';
import { FolderResults, type FolderEnv } from './automation';
import { copyingApp } from './clipboard';
import { ItemEngine } from './items';
import { appPathFromReg, attachedAutomation, attachedPipelines, chosenPipeline, pipelineChoices, resolveApp, runForApp, tempRoots, type PipelineHost } from './pipelines';

const balanced = { mode: 'balanced', format: 'auto', scale: 1 } as const;
const pipeline = (id: string, text: string, extra: Partial<Pipeline> = {}): Pipeline => ({ id, steps: parseSteps(text), rawText: text, skipOptimisation: false, hideResult: false, ...extra });

async function setup(t: TestContext, settings: Partial<ClopSettings> = {}) {
  if (!needTools(t, 'pngquant')) return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'clop-app-pipelines-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = path.join(root, 'Desktop');
  await mkdir(files);
  const workdir = await new Workdir(path.join(root, 'work')).ensure(), marker = new OptimisedMarker(path.join(root, 'optimised.json'));
  const state = { settings: { ...defaultSettings(), imageDirs: [files], ...settings } as ClopSettings };
  const counter = { value: 0 }, effects = new FakeEffects(), counters: number[] = [], kept: string[][] = [];
  const host: PipelineHost = { env: () => ({ settings: state.settings, workdir, marker, counter }), effects: () => effects, counterChanged: value => counters.push(value), keep: files => kept.push(files) };
  const engine = new ItemEngine(path.join(workdir.temp, 'session'), () => state.settings);
  const image = async (name: string, width = 200, height = 120) => { const file = path.join(files, name); await graphic(width, height).png().toFile(file); return file; };
  return { root, files, workdir, marker, state, host, engine, effects, counters, kept, image };
}

test('the card offers saved pipelines for the result\'s type and refuses others', () => {
  const settings = { savedPipelines: [
    pipeline('builtin-image-webp', 'convert(to: webp)', { name: 'to WebP', fileType: 'image' }), pipeline('MINE', 'downscale(factor: 0.5)'),
    pipeline('VIDEO', 'removeAudio', { name: 'Silent', fileType: 'video' }), ...decodePipelines([{ id: 'NEWER', steps: [{ teleport: {} }] }])!,
  ] };
  assert.deepEqual(pipelineChoices(settings, 'image'), [
    { id: 'MINE', name: 'downscale(factor: 0.5)', text: 'downscale(factor: 0.5)' }, { id: 'builtin-image-webp', name: 'to WebP', text: 'convert(to: webp)' },
  ], 'built-ins last, unreadable entries left out');
  assert.equal(chosenPipeline(settings, 'image', 'MINE').id, 'MINE');
  assert.throws(() => chosenPipeline(settings, 'image', 'VIDEO'), /works on video files/);
  assert.throws(() => chosenPipeline(settings, 'image', 'NEWER'), /no longer saved/);
  for (const bad of [undefined, 3, '', 'x'.repeat(201), { id: 'MINE' }]) assert.throws(() => chosenPipeline(settings, 'image', bad), /Choose a saved pipeline/);
});

test('pipeline results in the work directory\'s temp folder are kept from the cleaner, apart from the session\'s own', () => {
  const temp = path.resolve('/w/temp'), session = path.join(temp, 'session-1');
  assert.deepEqual(tempRoots(temp, session, [path.join(temp, 'pipeline-a', 'step-1', 'x.png'), path.join(temp, 'pipeline-a', 'step-2', 'y.png'), path.join(session, 'id', 'z.png'), path.resolve('/home/x.png'), path.join(temp, 'loose.png')]), [path.join(temp, 'pipeline-a')]);
});

test('openWith only opens apps Windows knows, and programs by path only for the user\'s own pipelines', async () => {
  const apps: AppEntry[] = [
    { name: 'Paint', path: 'Microsoft.Paint_8wekyb3d8bbwe!App', running: false },
    { name: 'GIMP 2.10', path: 'C:\\Program Files\\GIMP 2\\bin\\gimp-2.10.exe', running: true },
  ];
  const files = new Set(['C:\\Tools\\viewer.exe', 'C:\\Users\\me\\Desktop\\tool.exe', 'C:\\Program Files\\Affinity\\Photo.exe']);
  const lookup = { apps: async () => apps, appPath: async (exe: string) => exe.toLowerCase() === 'affinity.exe' ? 'C:\\Program Files\\Affinity\\Photo.exe' : undefined, isFile: async (file: string) => files.has(file), watched: ['C:\\Users\\me\\Desktop'], allowExe: true };
  assert.equal(await resolveApp('paint', lookup), 'Microsoft.Paint_8wekyb3d8bbwe!App');
  assert.equal(await resolveApp('gimp-2.10', lookup), 'C:\\Program Files\\GIMP 2\\bin\\gimp-2.10.exe');
  assert.equal(await resolveApp('Microsoft.Paint_8wekyb3d8bbwe!App', lookup), 'Microsoft.Paint_8wekyb3d8bbwe!App');
  assert.equal(await resolveApp('Affinity', lookup), 'C:\\Program Files\\Affinity\\Photo.exe', 'an App Paths entry');
  assert.equal(await resolveApp('"C:\\Tools\\viewer.exe"', lookup), 'C:\\Tools\\viewer.exe');
  await assert.rejects(resolveApp('C:\\Tools\\viewer.exe', { ...lookup, allowExe: false }), /cannot open programs by path/);
  await assert.rejects(resolveApp('C:\\Users\\me\\Desktop\\tool.exe', lookup), /inside the watched folder/);
  await assert.rejects(resolveApp('C:\\Tools\\missing.exe', lookup), /App 'C:\\Tools\\missing.exe' not found/);
  await assert.rejects(resolveApp('Photoshop', lookup), /App 'Photoshop' not found/);
  await assert.rejects(resolveApp('..\\viewer', lookup), /not found/);
  // Apps Windows lists and App Paths entries are held to the same rule as programs named by path.
  const risky = { ...lookup, apps: async () => [...apps, { name: 'Dropped', path: 'C:\\Users\\me\\Desktop\\dropped.exe', running: true }], appPath: async () => 'C:\\Users\\me\\Desktop\\registered.exe', isFile: async () => true };
  await assert.rejects(resolveApp('Dropped', risky), /inside the watched folder/);
  await assert.rejects(resolveApp('registered', risky), /inside the watched folder/);
  assert.equal(await resolveApp('paint', risky), 'Microsoft.Paint_8wekyb3d8bbwe!App', 'a packaged app\'s ID is not a path');
});

test('App Paths entries are read from reg.exe output, with variables expanded', () => {
  assert.equal(appPathFromReg('\r\nHKEY_CURRENT_USER\\…\\App Paths\\x.exe\r\n    (Default)    REG_SZ    C:\\Apps\\x.exe\r\n'), 'C:\\Apps\\x.exe');
  assert.equal(appPathFromReg('    (Default)    REG_EXPAND_SZ    "%ProgramFiles%\\Y\\y.exe"', { PROGRAMFILES: 'C:\\Program Files' }), 'C:\\Program Files\\Y\\y.exe');
  assert.equal(appPathFromReg('    (Default)    REG_SZ    y.exe'), undefined, 'a bare name is not a path');
  assert.equal(appPathFromReg('\r\n    (Standard)    REG_SZ    C:\\Apps\\z.exe\r\n'), 'C:\\Apps\\z.exe', 'the value\'s name is localised');
  assert.equal(appPathFromReg('ERROR: The system was unable to find the specified registry key or value.'), undefined);
});

test('the copying app is named for if(copiedBy:)', () => {
  assert.deepEqual(copyingApp({ owner: 'C:\\Windows\\System32\\mspaint.exe' }), { id: 'C:\\Windows\\System32\\mspaint.exe', name: 'mspaint' });
  assert.deepEqual(copyingApp({ owner: 'C:\\x.exe', aumid: 'Microsoft.ScreenSketch_8wekyb3d8bbwe!App' }), { id: 'Microsoft.ScreenSketch_8wekyb3d8bbwe!App', name: 'Microsoft.ScreenSketch' });
  assert.equal(copyingApp({}), undefined);
});

test('clipboard pipelines that skip optimisation replace it, starting from a copy of the original', async t => {
  const f = await setup(t); if (!f) return;
  f.state.settings = { ...f.state.settings, pipelinesToRunOnImage: { clipboard: [pipeline('WEBP', 'convert(to: webp)')] } };
  const input = await f.image('shot.png'), bytes = await readFile(input);
  const pipelines = attachedPipelines('image', 'clipboard', f.state.settings);
  const automation = attachedAutomation(pipelines, { host: f.host, context: { kind: 'image' }, fallback: true })!;
  assert.equal(automation.skipOptimisation, true, 'convert leads, so there is no optimisation first');
  const id = await f.engine.importPath(input, 'clipboard', balanced, undefined, { automation });
  const result = f.engine.get(id).result, output = f.engine.output(id);
  assert.deepEqual([result.status, result.format, path.extname(output)], ['ready', 'webp', '.webp']);
  assert.equal(result.outputBytes, (await stat(output)).size);
  assert.equal((await sharp(output).metadata()).format, 'webp');
  assert.deepEqual(await readFile(input), bytes, 'the copied file is never written to');
  await f.engine.restore(id);
  assert.equal(path.extname(f.engine.output(id)), '.png', 'restoring gives back the original');
});

test('when a filter stops every clipboard pipeline, the image is optimised as usual', async t => {
  const f = await setup(t); if (!f) return;
  const automation = attachedAutomation([pipeline('ONLY', 'if(nameContains: "nope") -> convert(to: webp)')], { host: f.host, context: { kind: 'image' }, fallback: true })!;
  const id = await f.engine.importPath(await f.image('photo.png', 600, 400), 'clipboard', balanced, undefined, { automation });
  const result = f.engine.get(id).result;
  assert.deepEqual([result.status, result.format, result.unchanged], ['ready', 'png', false]);
  assert.ok(result.outputBytes < result.originalBytes);
});

test('pipelines that follow optimisation run on the optimised result, and their warnings and failures show on the card', async t => {
  const f = await setup(t); if (!f) return;
  const automation = attachedAutomation([
    pipeline('COPY', 'copyToClipboard(format: markdown)', { name: 'Markdown' }), pipeline('SHARE', 'copyLinkForSending', { name: 'Share' }),
  ], { host: f.host, context: { kind: 'image' }, fallback: true })!;
  assert.equal(automation.skipOptimisation, false);
  const id = await f.engine.importPath(await f.image('shot.png', 600, 400), 'clipboard', balanced, undefined, { automation });
  const result = f.engine.get(id).result;
  assert.equal(result.status, 'ready');
  assert.ok(result.outputBytes < result.originalBytes, 'optimised first');
  assert.deepEqual(f.effects.clipboard.map(item => 'text' in item && item.text.replace(/\(.*\)/, '(…)')), ['[shot](…)']);
  assert.match((f.effects.clipboard[0] as { text: string }).text, /session.*shot\.png\)$/, 'on the optimised file in the shelf');
  assert.deepEqual(result.notes, ['Share: Step 1, copyLinkForSending, failed: Share links need an upload target in Settings.']);
});

test('the card runs a saved pipeline on its result, saving the counter and keeping temporary results', async t => {
  const f = await setup(t); if (!f) return;
  // A photo: a flat graphic scaled down can come out larger, and then the image optimiser keeps it as it was.
  const input = path.join(f.files, 'logo.png');
  await photo(400, 200).png().toFile(input);
  const id = await f.engine.importPath(input, 'drop', balanced);
  const run = (text: string) => f.engine.runPipeline(id, async input => {
    const outcome = await runForApp(f.host, [pipeline('P', text)], input.optimised ?? await input.fresh(), { kind: 'image' }, input.signal);
    return { file: outcome.file, anyRan: outcome.anyRan, warnings: outcome.warnings };
  });
  await run('downscale(factor: 0.5, location: temporaryFolder)');
  const result = f.engine.get(id).result, output = f.engine.output(id);
  assert.deepEqual([result.status, result.width, result.height], ['ready', 200, 100]);
  assert.ok(f.workdir.owns(output) && !output.includes('session'), output);
  assert.deepEqual(f.kept.at(-1), [output]);
  await run(`copy(to: "%P/numbered-%i")`);
  assert.deepEqual(f.counters, [1], 'the %i counter is saved');
  assert.match(path.basename(f.engine.output(id)), /^numbered-1\.png$/);
});

test('a watched folder\'s pipelines replace optimisation and work on the file where it is; a card that did nothing stays out of sight', async t => {
  const f = await setup(t); if (!f) return;
  f.state.settings = { ...f.state.settings, pipelinesToRunOnImage: { [f.files]: [referenceTo(pipeline('builtin-image-webp', 'convert(to: webp)'))] }, savedPipelines: [pipeline('builtin-image-webp', 'convert(to: webp)', { name: 'to WebP' })] };
  const quiet: string[] = [], counter = { value: 0 };
  const env = (): FolderEnv => ({ settings: f.state.settings, workdir: f.workdir, marker: f.marker, counter });
  const folders = new FolderResults({
    engine: f.engine, settings: () => f.state.settings, env, options: () => balanced, makeRoom: async () => {}, quiet: id => quiet.push(id),
    automation: (file, kind, dir, id) => {
      const pipelines = attachedPipelines(kind, dir, f.state.settings);
      return attachedAutomation(pipelines, { host: f.host, context: { kind }, fallback: false, source: file, done: outcome => { if (!outcome.anyRan) quiet.push(id()!); } });
    },
  });
  const shot = await f.image('shot.png');
  const placed = await folders.optimise(shot, 'image', f.files);
  assert.equal(placed, path.join(f.files, 'shot.webp'));
  assert.deepEqual((await readdir(f.files)).sort(), ['shot.png', 'shot.webp'], 'a conversion lands beside the file, which is not optimised first');
  assert.deepEqual(quiet, []);

  f.state.settings = { ...f.state.settings, pipelinesToRunOnImage: { [f.files]: [pipeline('NOPE', 'if(types: jpeg) -> convert(to: webp)')] } };
  const other = await f.image('other.png'), bytes = await readFile(other);
  await folders.optimise(other, 'image', f.files);
  assert.equal(quiet.length, 1, 'nothing ran, so the card is hidden');
  assert.deepEqual(await readFile(other), bytes, 'and the file is left as it was');
});

test('a reference to a deleted saved pipeline attaches nothing', () => {
  const settings = { ...defaultSettings(), pipelinesToRunOnImage: { clipboard: [referenceTo(pipeline('GONE', 'optimise'))] } };
  assert.deepEqual(attachedPipelines('image', 'clipboard', settings), []);
  assert.equal(attachedAutomation([], { host: {} as PipelineHost, context: { kind: 'image' }, fallback: true }), undefined);
});

test('a card action after a pipeline puts its own result forward, not the pipeline\'s file', async t => {
  const f = await setup(t); if (!f) return;
  const automation = attachedAutomation([pipeline('WEBP', 'convert(to: webp)')], { host: f.host, context: { kind: 'image' }, fallback: true })!;
  const id = await f.engine.importPath(await f.image('shot.png', 600, 400), 'clipboard', balanced, undefined, { automation });
  assert.equal(path.extname(f.engine.output(id)), '.webp');
  await f.engine.apply(id, { ...balanced, format: 'png' });
  assert.equal(f.engine.get(id).result.status, 'ready');
  assert.equal(path.extname(f.engine.output(id)), '.png', 'the converted result is what is copied and dragged');
});

test('a result is not ready, to copy or drag, until the pipelines after its optimisation are done', async t => {
  const f = await setup(t); if (!f) return;
  const seen: string[] = [];
  let id: string | undefined;
  const automation = { skipOptimisation: false, fallback: true, run: async (input: { optimised?: string }) => {
    seen.push(f.engine.get(id!).result.status);
    assert.throws(() => f.engine.output(id!), /Wait for this result/);
    return { file: input.optimised!, anyRan: false, warnings: [] };
  } };
  id = await f.engine.importPath(await f.image('shot.png', 600, 400), 'clipboard', balanced, undefined, { automation, staged: staged => { id = staged; } });
  assert.deepEqual(seen, ['processing']);
  assert.equal(f.engine.get(id).result.status, 'ready');
  assert.doesNotThrow(() => f.engine.output(id!));
});

test('a file a pipeline changed in the watched folder is not "restored" over its changes', async t => {
  const f = await setup(t); if (!f) return;
  f.state.settings = { ...f.state.settings, pipelinesToRunOnImage: { [f.files]: [pipeline('HALF', 'downscale(factor: 0.5)', { skipOptimisation: true })] } };
  const env = (): FolderEnv => ({ settings: f.state.settings, workdir: f.workdir, marker: f.marker, counter: { value: 0 } });
  const folders = new FolderResults({
    engine: f.engine, settings: () => f.state.settings, env, options: () => balanced, makeRoom: async () => {}, quiet: () => {},
    automation: (file, kind, dir) => attachedAutomation(attachedPipelines(kind, dir, f.state.settings), { host: f.host, context: { kind }, fallback: false, source: file }),
  });
  const shot = await f.image('shot.png', 400, 200), original = await readFile(shot);
  await folders.optimise(shot, 'image', f.files);
  assert.equal((await sharp(shot).metadata()).width, 200, 'the pipeline changed the watched file');
  const id = f.engine.list()[0].id;
  await assert.rejects(() => f.engine.restore(id), /changed shot\.png.*in the backups/);
  assert.equal((await sharp(shot).metadata()).width, 200);
  assert.deepEqual(await Promise.all((await readdir(f.workdir.backups)).map(name => readFile(path.join(f.workdir.backups, name)))), [original], 'the original is kept');
});

test('a pipeline that makes a video a GIF gives the card the GIF\'s kind, so its actions follow', async t => {
  const f = await setup(t); if (!f) return;
  if (!needTools(t, 'ffmpeg', 'ffprobe', 'gifski')) return;
  const input = await clip(path.join(f.root, 'clip.mp4'), { width: 160, height: 120, seconds: 1 });
  const automation = attachedAutomation([pipeline('GIF', 'convert(to: gif)')], { host: f.host, context: { kind: 'video' }, fallback: true })!;
  const id = await f.engine.importPath(input, 'clipboard', balanced, undefined, { automation });
  const result = f.engine.get(id).result;
  assert.deepEqual([result.status, result.kind, result.format], ['ready', 'image', 'gif'], result.error);
  assert.equal(path.extname(f.engine.output(id)), '.gif');
  await f.engine.apply(id, { ...balanced, scale: 0.5 });
  assert.equal(f.engine.get(id).result.status, 'ready', f.engine.get(id).result.error);
});
