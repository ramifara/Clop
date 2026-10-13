import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OptimisedMarker } from '../core/marker';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { needTools } from '../core/testing';
import { exists } from '../core/fileops';
import { Workdir } from '../core/workdir';
import { graphic } from '../core/media/image.fixtures';
import { folderPlacement, type FolderEnv } from './automation';
import { AS_IS, droppedFileExtra } from './drop-placement';
import { ItemEngine, type ItemAutomation, type ItemPlacement } from './items';

const balanced = { mode: 'balanced', format: 'auto', scale: 1 } as const;
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
const automation = (skipOptimisation: boolean): ItemAutomation => ({ skipOptimisation, fallback: true, run: async ({ original }) => ({ file: original, anyRan: true, warnings: [] }) });
const placement: ItemPlacement = { place: async output => output.path, restore: async () => undefined };

test('a dropped file gets the placement for the kind its content turns out to be', () => {
  const kinds: string[] = [];
  const extra = droppedFileExtra(undefined, { placement: kind => { kinds.push(kind); return placement; }, marked: false, aggressive: false, zone: false });
  assert.equal(extra.placement, undefined, 'nothing is placed before the content is read');
  assert.deepEqual(extra.late?.('video'), { placement });
  assert.deepEqual(kinds, ['video']);
  assert.deepEqual(droppedFileExtra(undefined, { marked: false, aggressive: false, zone: false }).late?.('image'), {}, 'a file Clop owns has no placement');
});

test('a file Clop optimised already is shown as it is, unless Shift was held or its pipelines skip optimisation', () => {
  const plain = droppedFileExtra(undefined, { marked: true, aggressive: false, zone: false }).late?.('image');
  assert.equal(plain?.automation, AS_IS);
  assert.equal(droppedFileExtra(undefined, { marked: true, aggressive: true, zone: false }).late?.('image')?.automation, undefined, 'Shift optimises it again');
  // The drop zone's pipelines after optimisation are skipped with it, as macOS refuses the file before it runs them.
  const after = automation(false), staged = () => {};
  const dropZone = droppedFileExtra({ late: () => ({ automation: after, staged }) }, { marked: true, aggressive: false, zone: false }).late?.('image');
  assert.equal(dropZone?.automation, AS_IS);
  assert.equal(dropZone?.staged, staged);
  // Pipelines that skip optimisation still run: macOS looks them up before it checks the mark.
  const skipping = automation(true);
  assert.equal(droppedFileExtra({ late: () => ({ automation: skipping }) }, { marked: true, aggressive: false, zone: false }).late?.('image')?.automation, skipping);
  // A preset zone's pipeline runs on the file as it is, without optimising it first.
  const zone = droppedFileExtra({ late: () => ({ automation: after }) }, { marked: true, aggressive: false, zone: true }).late?.('image')?.automation;
  assert.deepEqual([zone?.skipOptimisation, zone?.fallback, zone?.run], [true, false, after.run]);
  // A file that is not marked keeps its pipelines as they are.
  assert.equal(droppedFileExtra({ late: () => ({ automation: after }) }, { marked: false, aggressive: false, zone: false }).late?.('image')?.automation, after);
});

async function setup(t: TestContext, overrides: Partial<ClopSettings> = {}) {
  if (!needTools(t, 'pngquant')) return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'clop-drops-')), dir = path.join(root, 'Downloads');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(dir);
  const workdir = await new Workdir(path.join(root, 'work')).ensure(), marker = new OptimisedMarker(path.join(root, 'optimised.json'));
  const state = { settings: { ...defaultSettings(), ...overrides } as ClopSettings };
  const engine = new ItemEngine(path.join(workdir.temp, 'session'), () => state.settings, file => marker.markOptimised(file)), counter = { value: 0 };
  const env = (): FolderEnv => ({ settings: state.settings, workdir, marker, counter });
  /** What the app does for a drop on the drop zone (`droppedFile` in main.ts). */
  const drop = async (file: string, { aggressive = false } = {}) => engine.importPath(file, 'drop', { ...balanced, mode: aggressive ? 'aggressive' : 'balanced' }, undefined, droppedFileExtra(undefined, {
    placement: kind => folderPlacement(file, kind, env), marked: await marker.isOptimised(file), aggressive, zone: false,
  }));
  const file = path.join(dir, 'shot.png');
  await graphic(480, 320).png({ compressionLevel: 0 }).toFile(file);
  return { workdir, marker, engine, drop, file, state };
}

test('a dropped image replaces the file with a backup by default, and Restore puts the original back', async t => {
  const f = await setup(t); if (!f) return;
  const before = await digest(f.file), size = (await stat(f.file)).size;
  const id = await f.drop(f.file);
  const item = f.engine.get(id).result;
  assert.deepEqual([item.status, item.source, f.engine.output(id)], ['ready', 'drop', f.file], item.error);
  assert.ok((await stat(f.file)).size < size, 'the file itself is optimised');
  const [backup] = await readdir(f.workdir.backups);
  assert.equal(await digest(path.join(f.workdir.backups, backup)), before, 'the original is in the backups');
  assert.equal(await f.marker.isOptimised(f.file), true);
  await f.engine.restore(id);
  assert.equal(await digest(f.file), before, 'Restore gives the original back');
});

test('a dropped file that Clop optimised already is left as it is, unless Shift is held', async t => {
  const f = await setup(t); if (!f) return;
  await f.drop(f.file);
  const optimised = await digest(f.file), { mtimeMs } = await stat(f.file);
  const again = await f.drop(f.file), result = f.engine.get(again).result;
  assert.deepEqual([result.status, result.unchanged, result.outputBytes, result.originalBytes], ['ready', true, result.originalBytes, (await stat(f.file)).size]);
  assert.deepEqual([await digest(f.file), (await stat(f.file)).mtimeMs], [optimised, mtimeMs], 'nothing is written');
  assert.equal((await readdir(f.workdir.backups)).length, 1, 'no second backup');
  const aggressive = await f.drop(f.file, { aggressive: true });
  assert.equal(f.engine.get(aggressive).result.status, 'ready');
  assert.equal(f.engine.get(aggressive).result.unchanged, false, 'Shift optimises it again');
});

test('dropped files follow the placement settings: a copy beside the file, and a card conversion by the manual conversion settings', async t => {
  const f = await setup(t, { optimisedImageBehaviour: 'sameFolder' }); if (!f) return;
  const before = await digest(f.file), copy = path.join(path.dirname(f.file), 'shot-optimised.png');
  const id = await f.drop(f.file);
  assert.equal(f.engine.output(id), copy);
  assert.equal(await digest(f.file), before, 'the original stays as it was');
  assert.ok((await stat(copy)).size < (await stat(f.file)).size);
  // Converting from the card is a manual conversion: `manualConvertedImageBehaviour` (beside the file, `%f`) names it, and it takes the copy's place.
  await f.engine.apply(id, { ...balanced, format: 'webp' });
  const webp = path.join(path.dirname(f.file), 'shot.webp');
  assert.equal(f.engine.output(id), webp, f.engine.get(id).result.error);
  assert.equal(await exists(copy), false, 'the earlier copy makes way for the conversion');
  await f.engine.restore(id);
  assert.equal(await digest(f.file), before);
  assert.equal(await exists(webp), false, 'Restore removes the conversion it placed');
});

test('a dropped file with the temporary setting stays in the shelf only', async t => {
  const f = await setup(t, { optimisedImageBehaviour: 'temporary' }); if (!f) return;
  const before = await digest(f.file);
  const id = await f.drop(f.file);
  assert.notEqual(f.engine.output(id), f.file);
  assert.equal(await digest(f.file), before);
  assert.deepEqual(await readdir(path.dirname(f.file)), ['shot.png']);
});
