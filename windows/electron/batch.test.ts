import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OptimisedMarker } from '../core/marker';
import { photo } from '../core/media/image.fixtures';
import { defaultBatchParams } from '../core/batch/spec';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { needTools } from '../core/testing';
import { Workdir } from '../core/workdir';
import type { BatchViewState } from '../src/batch/types';
import { BatchHost } from './batch';

async function setup(t: TestContext, change: Partial<ClopSettings> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-batch-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const settings = { ...defaultSettings({ home: dir, desktop: dir, userData: dir }), batchModeFileCountThreshold: 3, ...change };
  const states: BatchViewState[] = [], revealed: string[] = [];
  let shown = 0;
  const host = new BatchHost({
    settings: () => settings, owns: file => workdir.owns(file), show: () => { shown++; }, publish: state => states.push(state), reveal: file => revealed.push(file),
    env: () => ({ workdir, settings: () => settings, marker: new OptimisedMarker(path.join(dir, 'optimised.json')), counter: { value: 0 } }),
  });
  t.after(() => host.stop());
  const file = async (name: string, data: Buffer | string = 'x') => { const target = path.join(dir, 'files', name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, data); return target; };
  return { dir, host, states, revealed, shown: () => shown, file, settings };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 50)); assert.ok(check(), 'timed out'); };

test('drops of a folder or of more files than the threshold go to the batch window', async t => {
  const { dir, host, file, shown } = await setup(t);
  const few = await Promise.all(['a.png', 'b.png', 'c.png'].map(name => file(name)));
  assert.equal(await host.drop(few), false, 'up to the threshold, files become cards');
  assert.equal(shown(), 0);
  assert.equal(await host.drop([...few, await file('d.mp4')], true), true);
  assert.equal(shown(), 1);
  assert.deepEqual(host.state().files.map(f => path.basename(f.path)), ['a.png', 'b.png', 'c.png', 'd.mp4']);
  assert.equal(host.state().defaults.aggressive, true, 'an aggressive drop seeds an aggressive batch');
  await file('sub/e.pdf'); await file('sub/notes.txt');
  assert.equal(await host.drop([path.join(dir, 'files', 'sub')]), true, 'a single folder opens the window');
  assert.deepEqual(host.state().files.map(f => path.basename(f.path)), ['a.png', 'b.png', 'c.png', 'd.mp4', 'e.pdf'], 'a later drop adds to the prepared files');
});

test('drops stay cards when batch mode is off or the request is malformed', async t => {
  const { dir, host, shown } = await setup(t, { useBatchModeForFolders: false });
  assert.equal(await host.drop([dir]), false);
  const on = await setup(t);
  for (const bad of [undefined, 'C:\\a.png', [], [1], ['relative/a.png'], [on.dir, 42]]) assert.equal(await on.host.drop(bad), false, JSON.stringify(bad));
  assert.equal(shown() + on.shown(), 0);
});

test('starting, revealing, cancelling and reverting only accept what the window was given', async t => {
  const { host, file, revealed } = await setup(t);
  const a = await file('a.png'), elsewhere = await file('../elsewhere.png');
  await host.add([a]);
  const params = defaultBatchParams(defaultSettings());
  await assert.rejects(host.add(['relative.png']), /Drop up to/);
  await assert.rejects(host.start({ files: [elsewhere], params }), /Only files listed/);
  await assert.rejects(host.start({ files: [], params }), /Choose the files/);
  await assert.rejects(host.start({ files: [a], params: { ...params, output: { location: 'folder', folder: 'out', template: '%f' } } }), /folder/);
  await assert.rejects(host.start(null), /Choose the files/);
  assert.throws(() => host.reveal(elsewhere), /Choose a file of this batch/);
  assert.throws(() => host.reveal('a.png'), /Choose a file of this batch/);
  host.reveal(a);
  assert.deepEqual(revealed, [a]);
  for (const id of [undefined, 'not-an-id', '00000000-0000-4000-8000-000000000000']) {
    assert.throws(() => host.cancel(id), /no longer open/);
    await assert.rejects(host.revert(id), /no longer open/);
    assert.throws(() => host.failures(id), /no longer open/);
  }
});

test('a started batch runs, reports its rows, reverts, and a later drop starts a new batch', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { host, states, file, revealed } = await setup(t);
  const a = await file('a.jpg', await photo(320, 240, 1).jpeg({ quality: 98 }).toBuffer()), b = await file('b.jpg', await photo(320, 240, 2).jpeg({ quality: 98 }).toBuffer());
  const original = await readFile(a);
  await host.add([a, b]);
  await host.start({ files: [a], params: defaultBatchParams(defaultSettings()) });
  assert.deepEqual(host.state().files, [], 'the prepared list gives way to the batch');
  await until(() => host.state().batch?.phase === 'finished');
  const batch = host.state().batch!;
  assert.deepEqual(batch.items.map(item => [item.name, item.status]), [['a.jpg', 'done']], 'only the chosen file ran');
  assert.ok(states.some(state => state.batch?.items[0].status === 'running'), 'the window heard the row run');
  assert.ok(!(await readFile(a)).equals(original));
  host.reveal(batch.backups);
  assert.deepEqual(revealed, [batch.backups]);
  assert.deepEqual(await host.revert(batch.id), []);
  assert.ok((await readFile(a)).equals(original));
  await host.add([b]);
  assert.equal(host.state().batch, undefined, 'a drop after a batch starts a new one');
  assert.deepEqual(host.state().files.map(f => f.path), [b]);
  host.clear();
  assert.deepEqual([host.state().files, host.state().batch], [[], undefined]);
});
