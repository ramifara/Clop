import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exists } from './fileops';
import { OptimisedMarker } from './marker';

async function folder(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-marker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const DAY = 86400000;
/** The cache key for a file: Windows ignores case. */
const keyOf = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
async function setup(t: TestContext, options: ConstructorParameters<typeof OptimisedMarker>[1] = {}) {
  const dir = await folder(t), file = path.join(dir, 'a.png'), cache = path.join(dir, 'cache', 'optimised.json');
  await writeFile(file, 'pixels');
  return { dir, file, cache, marker: new OptimisedMarker(cache, options) };
}

test('a file is optimised only after it is marked, and stays so across restarts', async t => {
  const { file, cache, marker } = await setup(t);
  assert.equal(await marker.isOptimised(file), false);
  await marker.markOptimised(file);
  assert.equal(await marker.isOptimised(file), true);
  assert.equal(await new OptimisedMarker(cache).isOptimised(file), true, 'a new instance reads the sidecar file');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(cache, 'utf8'))), [keyOf(file)]);
});

test('changing the content, size or modification time clears the mark', async t => {
  const { file, marker } = await setup(t);
  await marker.markOptimised(file);
  const info = await stat(file);
  await utimes(file, info.atime, new Date(info.mtimeMs + 5000));
  assert.equal(await marker.isOptimised(file), false, 'newer modification time');
  await marker.markOptimised(file);
  await writeFile(file, 'pixels, edited');
  assert.equal(await marker.isOptimised(file), false, 'different size');
  await marker.markOptimised(file);
  assert.equal(await marker.isOptimised(file), true, 'marking again records the new version');
});

test('a file saved through a temporary file and renamed over the original is no longer marked', async t => {
  const { dir, file, marker } = await setup(t);
  await marker.markOptimised(file);
  await writeFile(path.join(dir, 'a.tmp'), 'other pixels!');
  await rename(path.join(dir, 'a.tmp'), file);
  assert.equal(await marker.isOptimised(file), false);
});

test('a missing file is not optimised, and a relative path is the same file', async t => {
  const { dir, file, marker } = await setup(t);
  assert.equal(await marker.isOptimised(path.join(dir, 'gone.png')), false);
  await marker.markOptimised(file);
  assert.equal(await marker.isOptimised(path.relative(process.cwd(), file)), true);
  await rm(file);
  assert.equal(await marker.isOptimised(file), false);
  await assert.rejects(marker.markOptimised(file));
  assert.equal(await exists(file), false, 'marking a missing file must not create it (a stream write would)');
});

test('unmark forgets a file', async t => {
  const { file, marker } = await setup(t);
  await marker.markOptimised(file);
  await marker.unmark(file);
  assert.equal(await marker.isOptimised(file), false);
  assert.deepEqual(JSON.parse(await readFile(marker.file, 'utf8')), {});
});

test('on Windows paths that differ only by case are the same file', async t => {
  const { file, marker } = await setup(t, { platform: 'win32' });
  // The ADS hint is skipped off Windows, so only the sidecar is exercised here.
  await marker.markOptimised(file);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(marker.file, 'utf8'))), [path.resolve(file).toLowerCase()]);
});

test('loading drops entries that are expired or whose file is gone, and rewrites the cache', async t => {
  const { dir, file, cache } = await setup(t);
  const stale = path.join(dir, 'stale.png'), gone = path.join(dir, 'gone.png');
  await writeFile(stale, 'old');
  const now = Date.now(), recent = await stat(file), old = await stat(stale);
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, JSON.stringify({
    [path.resolve(file)]: { size: recent.size, mtimeMs: recent.mtimeMs, at: now - 29 * DAY },
    [path.resolve(stale)]: { size: old.size, mtimeMs: old.mtimeMs, at: now - 31 * DAY },
    [path.resolve(gone)]: { size: 1, mtimeMs: 1, at: now },
    broken: { size: 'x' },
  }));
  const marker = new OptimisedMarker(cache, { now: () => now });
  assert.equal(await marker.isOptimised(file), true);
  assert.equal(await marker.isOptimised(stale), false);
  for (const end = Date.now() + 2000; Object.keys(JSON.parse(await readFile(cache, 'utf8'))).length > 1 && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(Object.keys(JSON.parse(await readFile(cache, 'utf8'))), [keyOf(file)]);
});

test('entries written with another casing still match on Windows', async t => {
  const { file, cache } = await setup(t);
  const info = await stat(file);
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, JSON.stringify({ [path.resolve(file)]: { size: info.size, mtimeMs: info.mtimeMs, at: Date.now() } }));
  assert.equal(await new OptimisedMarker(cache, { platform: 'win32' }).isOptimised(file), true);
});

test('the cache never holds more than the limit, dropping the oldest marks first', async t => {
  const { dir, marker } = await setup(t, { maxEntries: 3 });
  const files = [];
  for (let i = 0; i < 5; i++) { const file = path.join(dir, `f${i}.png`); await writeFile(file, `data ${i}`); files.push(file); await marker.markOptimised(file); }
  assert.deepEqual(await Promise.all(files.map(file => marker.isOptimised(file))), [false, false, true, true, true]);
  assert.equal(Object.keys(JSON.parse(await readFile(marker.file, 'utf8'))).length, 3);
});

test('a damaged or unexpected cache file is an empty cache', async t => {
  const { file, cache } = await setup(t);
  for (const content of ['{"half": ', '[1,2]', 'null', '"text"']) {
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, content);
    const marker = new OptimisedMarker(cache);
    assert.equal(await marker.isOptimised(file), false);
    await marker.markOptimised(file);
    assert.equal(await marker.isOptimised(file), true);
  }
});

test('many marks at once are all saved, with no temporary files left behind', async t => {
  const { dir, cache, marker } = await setup(t);
  const files = [];
  for (let i = 0; i < 40; i++) { const file = path.join(dir, `p${i}.png`); await writeFile(file, `data ${i}`); files.push(file); }
  await Promise.all(files.map(file => marker.markOptimised(file)));
  const fresh = new OptimisedMarker(cache);
  assert.deepEqual(await Promise.all(files.map(file => fresh.isOptimised(file))), files.map(() => true));
  assert.deepEqual(await readdir(path.dirname(cache)), ['optimised.json']);
});

test('on Windows marking also writes the alternate data stream hint', { skip: process.platform !== 'win32' }, async t => {
  const { file, marker } = await setup(t);
  assert.equal(await marker.hint(file), undefined);
  await marker.markOptimised(file);
  assert.equal(await marker.hint(file), true);
  assert.equal(await readFile(`${file}:clop.optimisation.status`, 'utf8'), 'true');
  assert.equal(await marker.isOptimised(file), true, 'the stream does not disturb the recorded size and time');
});

test('the stream hint does not exist off Windows and never decides the answer', async t => {
  const { file, marker } = await setup(t, { platform: 'linux' });
  await marker.markOptimised(file);
  assert.equal(await marker.hint(file), undefined);
  await marker.unmark(file);
  assert.equal(await marker.isOptimised(file), false);
});
