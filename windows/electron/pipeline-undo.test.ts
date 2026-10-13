import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { graphic } from '../core/media/image.fixtures';
import { OptimisedMarker } from '../core/marker';
import { FakeEffects } from '../core/pipeline/executor.fixtures';
import type { Pipeline } from '../core/pipeline/model';
import { parseSteps } from '../core/pipeline/parser';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { needTools } from '../core/testing';
import { Workdir } from '../core/workdir';
import { ItemEngine, type ItemAutomation } from './items';
import { beforeRun, undoRun } from './pipeline-undo';
import { attachedAutomation, type PipelineHost } from './pipelines';

const balanced = { mode: 'balanced', format: 'auto', scale: 1 } as const;
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
const pipeline = (text: string): Pipeline => ({ id: 'P', steps: parseSteps(text), rawText: text, skipOptimisation: true, hideResult: false });

async function setup(t: TestContext) {
  if (!needTools(t, 'pngquant')) return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'clop-undo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Downloads');
  await mkdir(dir);
  const workdir = await new Workdir(path.join(root, 'work')).ensure(), marker = new OptimisedMarker(path.join(root, 'optimised.json'));
  const settings = defaultSettings() as ClopSettings, counter = { value: 0 }, effects = new FakeEffects();
  const host: PipelineHost = { env: () => ({ settings, workdir, marker, counter }), effects: () => effects, counterChanged: () => {}, keep: () => {} };
  const engine = new ItemEngine(path.join(workdir.temp, 'session'), () => settings);
  const file = path.join(dir, 'shot.png');
  await graphic(480, 320).png().toFile(file);
  /** A drop whose pipeline skips optimisation and starts from the dropped file itself, as `droppedFile` in main.ts sets it up. */
  const drop = (text: string) => engine.importPath(file, 'drop', balanced, undefined, { automation: attachedAutomation([pipeline(text)], { host, context: { kind: 'image' }, fallback: true, source: file })! });
  return { dir, workdir, marker, engine, file, drop };
}

test('Restore after a pipeline that only wrote a file beside the original removes that file and keeps the original', async t => {
  const f = await setup(t); if (!f) return;
  const before = await digest(f.file);
  const id = await f.drop('convert(to: webp)');
  assert.equal(f.engine.output(id), path.join(f.dir, 'shot.webp'), f.engine.get(id).result.error);
  await f.engine.restore(id);
  assert.deepEqual(await readdir(f.dir), ['shot.png'], 'the WebP the pipeline made is gone');
  assert.equal(await digest(f.file), before, 'the original is as it was');
  assert.equal(f.engine.output(id), f.file);
  assert.equal(await f.marker.isOptimised(f.file), true, 'marked, so a watched folder leaves it alone');
});

test('Restore gives back a file of the user\'s that the pipeline\'s result took the place of', async t => {
  const f = await setup(t); if (!f) return;
  const theirs = path.join(f.dir, 'shot.webp');
  await writeFile(theirs, 'the user\'s own file');
  const id = await f.drop('convert(to: webp)');
  assert.notEqual(await readFile(theirs, 'utf8'), 'the user\'s own file');
  await f.engine.restore(id);
  assert.equal(await readFile(theirs, 'utf8'), 'the user\'s own file');
});

test('Restore after a pipeline that changed the original in place puts it back from the backup the step made', async t => {
  const f = await setup(t); if (!f) return;
  const before = await digest(f.file);
  const id = await f.drop('downscale(factor: 0.5)');
  assert.equal(f.engine.get(id).result.status, 'ready', f.engine.get(id).result.error);
  assert.notEqual(await digest(f.file), before, 'the step rewrote the file');
  assert.equal(f.engine.get(id).result.width, 240);
  await f.engine.restore(id);
  assert.equal(await digest(f.file), before);
  assert.deepEqual(await readdir(f.dir), ['shot.png']);
});

test('Restore refuses, and changes nothing, when the pipeline changed the original with no backup, or its file was edited since', async t => {
  const f = await setup(t); if (!f) return;
  // A pipeline step that writes the file itself, keeping no copy (as a script could).
  const env = { workdir: f.workdir, mark: (file: string) => f.marker.markOptimised(file) };
  const scribble: ItemAutomation = { skipOptimisation: true, fallback: false, run: async () => {
    const start = await beforeRun(env, f.file);
    await appendFile(f.file, 'scribbled');
    return { file: f.file, started: f.file, anyRan: true, warnings: [], undo: await undoRun(env, start, f.file) };
  } };
  const id = await f.engine.importPath(f.file, 'drop', balanced, undefined, { automation: scribble });
  const after = await digest(f.file);
  await assert.rejects(f.engine.restore(id), /changed shot\.png and kept no copy/);
  assert.equal(await digest(f.file), after, 'left as the pipeline left it');

  // A beside-only result the user edited afterwards stays, and so does the original.
  await f.engine.dismiss(id);
  const fresh = path.join(f.dir, 'fresh.png');
  await graphic(300, 200, { seed: 5 }).png().toFile(fresh);
  const engine = f.engine, before = await digest(fresh);
  const convert = attachedAutomation([pipeline('convert(to: webp)')], { host: { env: () => ({ settings: defaultSettings(), workdir: f.workdir, marker: f.marker, counter: { value: 0 } }), effects: () => new FakeEffects(), counterChanged: () => {}, keep: () => {} }, context: { kind: 'image' }, fallback: true, source: fresh })!;
  const other = await engine.importPath(fresh, 'drop', balanced, undefined, { automation: convert });
  const webp = path.join(f.dir, 'fresh.webp');
  assert.equal(engine.output(other), webp);
  await new Promise(resolve => setTimeout(resolve, 20));
  await appendFile(webp, 'edited');
  await assert.rejects(engine.restore(other), /fresh\.webp changed after the pipeline made it/);
  assert.equal(await digest(fresh), before);
  assert.ok((await readdir(f.dir)).includes('fresh.webp'));
});
