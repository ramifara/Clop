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
import { BatchHost, type BatchHostOptions } from './batch';

async function setup(t: TestContext, change: Partial<ClopSettings> = {}, extra: Partial<BatchHostOptions> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-batch-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const settings = { ...defaultSettings({ home: dir, desktop: dir, userData: dir }), batchModeFileCountThreshold: 3, ...change };
  const states: BatchViewState[] = [], revealed: string[] = [];
  let shown = 0;
  const host = new BatchHost({
    settings: () => settings, owns: file => workdir.owns(file), show: () => { shown++; }, publish: state => states.push(state), reveal: file => revealed.push(file), ...extra,
    env: () => ({ workdir, settings: () => settings, marker: new OptimisedMarker(path.join(dir, 'optimised.json')), counter: { value: 0 } }),
  });
  t.after(() => host.stop());
  const file = async (name: string, data: Buffer | string = 'x') => { const target = path.join(dir, 'files', name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, data); return target; };
  return { dir, host, states, revealed, shown: () => shown, file, settings };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 50)); assert.ok(check(), 'timed out'); };

test('a drop of more files than the threshold goes to the batch window whole; up to the threshold they stay cards', async t => {
  const { host, file, shown } = await setup(t);
  const few = await Promise.all(['a.png', 'b.png', 'c.png'].map(name => file(name)));
  assert.deepEqual(await host.drop(few), few, 'up to the threshold, files become cards');
  assert.equal(shown(), 0);
  assert.deepEqual(await host.drop([...few, await file('d.mp4')], true), [], 'one more than the threshold, the window takes them all');
  assert.equal(shown(), 1);
  assert.deepEqual(host.state().files.map(f => path.basename(f.path)), ['a.png', 'b.png', 'c.png', 'd.mp4']);
  assert.equal(host.state().defaults.aggressive, true, 'an aggressive drop seeds an aggressive batch');
});

test('a dropped folder goes to the batch window only when it holds more supported files than the threshold (optimiseDir)', async t => {
  const { dir, host, file, shown } = await setup(t);
  // The threshold is 3: three supported files (and a text file, which does not count) stay cards.
  for (const name of ['a.png', 'b.jpg', 'sub/c.pdf', 'notes.txt']) await file(path.join('small', name));
  const small = path.join(dir, 'files', 'small'), loose = await file('loose.png');
  assert.deepEqual(await host.drop([small]), [small], 'a folder with as many files as the threshold is optimised file by file');
  assert.equal(shown(), 0);
  for (const name of ['a.png', 'b.png', 'c.png', 'sub/d.mp4']) await file(path.join('large', name));
  const large = path.join(dir, 'files', 'large');
  assert.deepEqual(await host.drop([small, large, loose]), [small, loose], 'one more than the threshold: only that folder goes to the window');
  assert.equal(shown(), 1);
  assert.deepEqual(host.state().files.map(f => path.basename(f.path)), ['a.png', 'b.png', 'c.png', 'd.mp4']);
  await file('sub/e.pdf');
  assert.deepEqual(await host.drop([path.join(dir, 'files', 'sub')]), [path.join(dir, 'files', 'sub')], 'a folder with one file stays cards');
});

test('drops stay cards when batch mode is off or the request is malformed', async t => {
  const { dir, host, shown } = await setup(t, { useBatchModeForFolders: false, batchModeFileCountThreshold: 0 });
  assert.deepEqual(await host.drop([dir]), [dir]);
  const on = await setup(t);
  for (const bad of [undefined, 'C:\\a.png', [], [1], ['relative/a.png'], [on.dir, 42]]) assert.deepEqual(await on.host.drop(bad), bad, JSON.stringify(bad));
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
  await host.clear();
  assert.deepEqual([host.state().files, host.state().batch], [[], undefined]);
});

test('stopping for quit also waits for a revert that is under way', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { host, file } = await setup(t);
  const a = await file('a.jpg', await photo(320, 240, 1).jpeg({ quality: 98 }).toBuffer()), original = await readFile(a);
  await host.add([a]);
  await host.start({ files: [a], params: defaultBatchParams(defaultSettings()) });
  await until(() => host.state().batch?.phase === 'finished');
  const id = host.state().batch!.id, reverting = host.revert(id);
  const settling = host.stop();
  assert.ok(settling, 'there is a revert to wait for');
  await settling;
  assert.equal(host.state().batch?.phase, 'reverted', 'the originals were all given back before quitting went on');
  assert.ok((await readFile(a)).equals(original));
  await reverting;
});

test('stopping for quit waits until the running batch has settled', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { host, file } = await setup(t);
  const files = await Promise.all([1, 2, 3, 4].map(async n => file(`${n}.jpg`, await photo(640, 480, n).jpeg({ quality: 98 }).toBuffer())));
  await host.add(files);
  await host.start({ files, params: defaultBatchParams(defaultSettings()) });
  assert.equal(host.state().batch?.phase, 'running');
  await host.stop();
  assert.notEqual(host.state().batch?.phase, 'running', 'no file is still being worked on');
  assert.equal(host.stop(), undefined, 'a batch that is over has nothing to wait for');
});

test('results go only to a folder the folder chooser returned', async t => {
  const { dir, host, file } = await setup(t);
  const a = await file('a.png'), out = path.join(dir, 'out'), other = path.join(dir, 'other');
  await host.add([a]);
  const params = (folder: string, template = '%f') => ({ ...defaultBatchParams(defaultSettings()), output: { location: 'folder', folder, template } });
  await assert.rejects(host.start({ files: [a], params: params(out) }), /Choose the folder for the results/);
  assert.equal(await host.chooseFolder(async () => undefined), undefined, 'a cancelled dialog allows nothing');
  await assert.rejects(host.start({ files: [a], params: params(out) }), /Choose the folder/);
  assert.equal(await host.chooseFolder(async () => out), out);
  await assert.rejects(host.start({ files: [a], params: params(other) }), /Choose the folder/, 'only the chosen folder');
  await assert.rejects(host.start({ files: [a], params: params(path.join(out, '..', 'other')) }), /Choose the folder/, 'not by walking around');
  await assert.rejects(host.start({ files: [a], params: params(out, '../%f') }), /stay inside the chosen folder/);
  assert.equal(host.state().batch, undefined);
  await host.start({ files: [a], params: params(out + path.sep) });
  assert.ok(host.state().batch, 'the chosen folder is accepted');
  await until(() => host.state().batch?.phase !== 'running');
});

test('files dropped while others are still being read all join the batch, and the batch cannot start meanwhile', async t => {
  const { host, file } = await setup(t);
  const [a, b, c] = await Promise.all(['a.png', 'b.png', 'c.png'].map(name => file(name)));
  await Promise.all([host.add([a]), host.add([b]), host.add([c])]);
  assert.deepEqual(host.state().files.map(f => path.basename(f.path)).sort(), ['a.png', 'b.png', 'c.png'], 'no overlapping drop lost the files of another');
  const params = defaultBatchParams(defaultSettings());
  const more = host.add([await file('d.png')]);
  assert.equal(host.state().scanning, true);
  await assert.rejects(host.start({ files: [a], params }), /still being read/);
  await more;
  assert.equal(host.state().scanning, false);
  // Emptying the window while a drop is being read leaves it empty.
  const late = host.add([await file('e.png')]);
  const cleared = host.clear();
  await Promise.all([late, cleared]);
  assert.deepEqual(host.state().files, []);
});

test('files stored only in the cloud are skipped with a notice', async t => {
  const { host, file } = await setup(t, {}, { isLocal: async f => !f.includes('cloud') });
  const here = await file('here.png'), cloud = await file('cloud-only.png'), also = await file('cloud-too.png');
  await host.add([here, cloud, also]);
  assert.deepEqual(host.state().files.map(f => f.path), [here]);
  assert.deepEqual(host.state().notices, ['2 files that are only in the cloud were skipped, since reading them would download them.']);
  await host.clear();
  assert.deepEqual(host.state().notices, []);
  await host.add([cloud]);
  assert.deepEqual(host.state().notices, ['1 file that is only in the cloud was skipped, since reading it would download it.']);
});

test('dropping onto a finished batch asks first, and the earlier batch can be opened again to revert it', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { host, file, states } = await setup(t);
  const a = await file('a.jpg', await photo(320, 240, 1).jpeg({ quality: 98 }).toBuffer()), b = await file('b.jpg', await photo(320, 240, 2).jpeg({ quality: 98 }).toBuffer());
  const original = await readFile(a);
  await host.add([a]);
  await host.start({ files: [a], params: defaultBatchParams(defaultSettings()) });
  await until(() => host.state().batch?.phase === 'finished');
  const first = host.state().batch!;
  assert.ok(!(await readFile(a)).equals(original));

  await host.add([b]);
  assert.equal(host.state().batch?.id, first.id, 'the finished batch stays');
  assert.deepEqual([host.state().pendingAdd, host.state().files], [1, []]);
  host.cancelAdd();
  assert.equal(host.state().pendingAdd, undefined);
  assert.equal(host.state().batch?.id, first.id);
  await assert.rejects(host.confirmAdd(), /Nothing is waiting/);

  await host.add([b]);
  await host.confirmAdd();
  assert.deepEqual([host.state().batch, host.state().pendingAdd, host.state().files.map(f => f.path)], [undefined, undefined, [b]]);
  assert.deepEqual(host.state().previous, { id: first.id, files: 1 }, 'the earlier batch is offered');
  assert.ok(states.some(state => state.previous), 'and the window heard of it');

  await assert.rejects(host.reopen('00000000-0000-4000-8000-000000000000'), /no longer available/);
  // Prepared files are not discarded without asking: the window is asked, and only a yes opens the earlier batch.
  await host.reopen(first.id);
  assert.deepEqual([host.state().pendingReopen, host.state().batch, host.state().files.map(f => f.path)], [1, undefined, [b]]);
  host.cancelAdd();
  assert.deepEqual([host.state().pendingReopen, host.state().batch, host.state().files.map(f => f.path), host.state().previous?.id], [undefined, undefined, [b], first.id]);
  await host.reopen(first.id);
  await host.confirmAdd();
  assert.equal(host.state().pendingReopen, undefined);
  const reopened = host.state().batch!;
  assert.deepEqual([reopened.id, reopened.phase, reopened.items.map(item => [item.name, item.status])], [first.id, 'finished', [['a.jpg', 'done']]]);
  assert.deepEqual(host.state().files, [], 'the prepared files give way');
  assert.deepEqual(await host.revert(first.id), []);
  assert.ok((await readFile(a)).equals(original));
  await host.add([b]);
  assert.equal(host.state().batch, undefined, 'a reverted batch is replaced without asking');
  assert.equal(host.state().previous, undefined);
});
