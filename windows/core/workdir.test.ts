import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { exists } from './fileops';
import { stampArrival, Workdir } from './workdir';

async function folder(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-workdir-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const DAY = 86400;
const later = (days: number) => Date.now() + days * DAY * 1000;
async function put(file: string, content = 'x') { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); return file; }

test('lays out backups, batch-backups and temp under the root, expanding ~', async t => {
  const dir = await folder(t);
  const workdir = await new Workdir(path.join(dir, 'work')).ensure();
  assert.deepEqual((await readdir(workdir.root)).sort(), ['.clop-workdir', 'backups', 'batch-backups', 'temp']);
  assert.deepEqual([workdir.backups, workdir.batchBackups, workdir.temp], ['backups', 'batch-backups', 'temp'].map(name => path.join(dir, 'work', name)));
  assert.equal(new Workdir('~/Clop/work', { home: dir }).root, path.join(dir, 'Clop', 'work'));
  assert.equal(new Workdir('$HOME/work', { home: dir }).root, path.join(dir, 'work'));
});

test('an empty or relative working directory is refused instead of resolving against the current folder', () => {
  for (const root of ['', '   ', 'work', './work', '..\\work']) assert.throws(() => new Workdir(root), /working directory/, JSON.stringify(root));
  assert.throws(() => new Workdir('', { home: '/home/me' }), /empty/);
  assert.throws(() => new Workdir('relative/work'), /absolute path, not "relative\/work"/);
});

test('a copied backup restores byte for byte, including a binary file and its modification time', async t => {
  const dir = await folder(t), workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const original = path.join(dir, 'photo.jpg'), bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256));
  await writeFile(original, bytes);
  const when = new Date(2023, 5, 1, 12); await utimes(original, when, when);
  const backup = (await workdir.backup(original))!;
  assert.equal(path.dirname(backup), workdir.backups);
  assert.match(path.basename(backup), /^photo-[0-9a-f]{12}\.jpg$/);
  assert.deepEqual(await readFile(original), bytes);
  await writeFile(original, 'optimised');
  await workdir.restore(backup, original);
  assert.deepEqual(await readFile(original), bytes);
  assert.equal((await stat(original)).mtimeMs, when.getTime());
  assert.equal(await exists(backup), false);
});

test('a moved backup takes the original away, and the backup name follows the file version', async t => {
  const dir = await folder(t), workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const original = await put(path.join(dir, 'a.png'), 'first');
  const before = await workdir.backupPath(original);
  assert.equal(await workdir.backupPath(original), before);
  await writeFile(original, 'second version');
  assert.notEqual(await workdir.backupPath(original), before);
  const backup = (await workdir.backup(original, { move: true }))!;
  assert.equal(await exists(original), false);
  assert.equal(await readFile(backup, 'utf8'), 'second version');
  assert.equal(await workdir.latestBackup(original), backup);
  assert.equal(await workdir.backup(path.join(dir, 'missing.png')), undefined);
});

test('an existing backup of the same version is kept unless forced', async t => {
  const dir = await folder(t), workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const original = await put(path.join(dir, 'a.png'), 'same');
  const backup = (await workdir.backup(original))!;
  await writeFile(backup, 'edited backup');
  await workdir.backup(original);
  assert.equal(await readFile(backup, 'utf8'), 'edited backup');
  await workdir.backup(original, { force: true });
  assert.equal(await readFile(backup, 'utf8'), 'same');
});

test('cleanup removes old files and folders from backups and temp, and leaves batch backups alone', async t => {
  const dir = await folder(t), workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const old = [await put(path.join(workdir.backups, 'a.png')), await put(path.join(workdir.temp, 'session-1', 'deep', 'b.png'))];
  const batch = await put(path.join(workdir.batchBackups, 'batch-1', 'c.png'));
  assert.equal(await workdir.cleanup(3 * DAY), 0, 'fresh files stay');
  assert.equal(await workdir.cleanup(3 * DAY, later(2)), 0, 'younger than the interval stay');
  assert.equal(await workdir.cleanup(0, later(400)), 0, 'zero never deletes');
  assert.equal(await workdir.cleanup(3 * DAY, later(4)), 2);
  for (const file of old) assert.equal(await exists(file), false);
  assert.deepEqual(await readdir(workdir.temp), [], 'empty session folders go too');
  assert.equal(await exists(batch), true);
});

test('protected folders survive cleanup and force clean; force clean empties the rest but keeps batch backups', async t => {
  const dir = await folder(t), workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const session = path.join(workdir.temp, 'session-now');
  const live = await put(path.join(session, 'result.png')), stale = await put(path.join(workdir.temp, 'session-old', 'r.png'));
  const backup = await put(path.join(workdir.backups, 'b.png')), batch = await put(path.join(workdir.batchBackups, 'batch-1', 'c.png'));
  const unprotect = workdir.protect(session);
  assert.equal(await workdir.cleanup(DAY, later(10)), 2);
  assert.equal(await exists(live), true);
  assert.equal(await exists(stale), false);
  await put(path.join(workdir.temp, 'again.png'));
  assert.equal(await workdir.forceClean(), 1);
  assert.deepEqual([await exists(live), await exists(batch)], [true, true]);
  unprotect();
  assert.equal(await workdir.forceClean(), 1);
  assert.deepEqual([await exists(live), await exists(backup), await exists(batch)], [false, false, true]);
  assert.deepEqual((await readdir(workdir.root)).sort(), ['.clop-workdir', 'backups', 'batch-backups', 'temp'], 'the layout is recreated');
});

test('force clean removes files whatever their timestamps say, including ones dated after now', async t => {
  // File times come from a coarse clock and can run ahead of Date.now(), and a file can carry any mtime.
  const dir = await folder(t), workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const future = new Date(Date.now() + 3600_000), files = [await put(path.join(workdir.temp, 'a.png')), await put(path.join(workdir.backups, 'b.png'))];
  for (const file of files) await utimes(file, future, future);
  assert.equal(await workdir.forceClean(), 2);
  for (const file of files) assert.equal(await exists(file), false);
});

test('legacy folders age out with the cleanup interval and disappear once empty', async t => {
  const dir = await folder(t), legacy = path.join(dir, 'images');
  const workdir = await new Workdir(path.join(dir, 'work'), { legacy: [legacy] }).ensure();
  const file = await put(path.join(legacy, 'session-1', 'original.png'));
  assert.equal(await workdir.cleanup(7 * DAY), 0);
  assert.equal(await exists(file), true);
  assert.equal(await workdir.cleanup(0, later(30)), 0, 'zero never deletes');
  assert.equal(await exists(file), true);
  assert.equal(await workdir.cleanup(7 * DAY, later(8)), 1);
  assert.equal(await exists(legacy), false);
});

test('the cleaner sweeps right away, reads the interval on every pass and stops on request', async t => {
  const dir = await folder(t), workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const file = await put(path.join(workdir.temp, 'a.png'));
  let interval = 0;
  const stop = workdir.startCleaner(() => interval, 10, () => later(5));
  t.after(stop);
  await delay(80);
  assert.equal(await exists(file), true, 'zero keeps files');
  interval = 3 * DAY;
  for (const end = Date.now() + 2000; await exists(file) && Date.now() < end;) await delay(20);
  assert.equal(await exists(file), false);
  stop();
  await delay(100); // a pass that was already running may still finish
  const next = await put(path.join(workdir.temp, 'b.png'));
  await delay(80);
  assert.equal(await exists(next), true, 'a stopped cleaner does nothing');
});

test('a legacy folder that holds the working directory or batch backups is never swept', async t => {
  const dir = await folder(t), legacy = path.join(dir, 'images');
  // The working directory was pointed inside the old images folder.
  const nested = await new Workdir(path.join(legacy, 'work'), { legacy: [legacy] }).ensure();
  const batch = await put(path.join(nested.batchBackups, 'batch-1', 'c.png'));
  const other = await put(path.join(legacy, 'session-1', 'o.png'));
  await nested.cleanup(DAY, later(30));
  await nested.forceClean();
  assert.equal(await exists(batch), true);
  assert.equal(await exists(other), true, 'a folder that contains the working directory is not a legacy folder');
  // A legacy folder inside batch-backups is also left alone.
  const inside = new Workdir(path.join(dir, 'w2'), { legacy: [path.join(dir, 'w2', 'batch-backups', 'old'), path.join(dir, 'w2', 'old-images')] });
  await inside.ensure();
  const kept = await put(path.join(dir, 'w2', 'batch-backups', 'old', 'k.png'));
  const swept = await put(path.join(dir, 'w2', 'old-images', 's.png'));
  await inside.cleanup(DAY, later(30));
  assert.deepEqual([await exists(kept), await exists(swept)], [true, false]);
});

test('owns tells Clop-written folders apart from the rest of the root', async t => {
  const dir = await folder(t), workdir = new Workdir(dir);
  for (const inside of [path.join(workdir.temp, 'session-1', 'a.png'), path.join(workdir.backups, 'b.png'), path.join(workdir.batchBackups, 'x', 'c.png')]) assert.equal(workdir.owns(inside), true, inside);
  for (const outside of [path.join(dir, 'Pictures', 'a.png'), path.join(dir, 'temp-notes', 'a.png'), path.join(workdir.root, 'a.png'), path.join(dir, '..', 'temp', 'a.png')]) assert.equal(workdir.owns(outside), false, outside);
});

test('the cleaner refuses linked roots and never follows links inside them', { skip: process.platform === 'win32' ? 'creating links needs privileges on Windows' : false }, async t => {
  const dir = await folder(t), victim = path.join(dir, 'victim');
  const precious = await put(path.join(victim, 'precious.png'));
  const workdir = new Workdir(path.join(dir, 'work'));
  await mkdir(workdir.root, { recursive: true });
  await symlink(victim, workdir.backups, 'dir');
  await assert.rejects(workdir.ensure(), /is a link/);
  assert.equal(await workdir.cleanup(DAY, later(30)), 0);
  assert.equal(await workdir.forceClean().catch(() => 0), 0);
  assert.equal(await exists(precious), true);
  // A link planted inside a real folder is removed as a link; its target survives.
  await rm(workdir.backups);
  await workdir.ensure();
  await symlink(victim, path.join(workdir.temp, 'junction'), 'dir');
  assert.equal(await workdir.cleanup(DAY, later(30)), 1);
  assert.equal(await exists(precious), true);
  assert.deepEqual(await readdir(workdir.temp), []);
});

test('a folder that holds other files is refused, a Clop-made or empty one is accepted, and the choice is remembered', async t => {
  const dir = await folder(t);
  const broad = path.join(dir, 'profile');
  const theirs = await put(path.join(broad, 'temp', 'their-notes.txt'));
  await put(path.join(broad, 'Documents', 'a.docx'));
  await assert.rejects(new Workdir(broad).ensure(), /not Clop's/);
  assert.equal(await exists(theirs), true, 'nothing of theirs is touched');
  // Only Clop's own layout (an earlier start without the marker) is adopted.
  const earlier = path.join(dir, 'earlier');
  await put(path.join(earlier, 'backups', 'b.png'));
  await new Workdir(earlier).ensure();
  assert.ok((await readdir(earlier)).includes('.clop-workdir'));
  // Once marked, extra files beside the layout are fine.
  await put(path.join(earlier, 'notes.txt'));
  await new Workdir(earlier).ensure();
  // A new, empty folder works as before.
  await new Workdir(path.join(dir, 'fresh')).ensure();
});

test('a link anywhere on the working directory path is refused and never swept', { skip: process.platform === 'win32' ? 'creating links needs privileges on Windows' : false }, async t => {
  const dir = await folder(t), real = path.join(dir, 'real');
  await put(path.join(real, 'work', 'temp', 'victim.png'));
  await symlink(real, path.join(dir, 'via'), 'dir');
  const workdir = new Workdir(path.join(dir, 'via', 'work'));
  await assert.rejects(workdir.ensure(), /is a link/);
  assert.equal(await workdir.cleanup(DAY, later(30)), 0);
  assert.equal(await exists(path.join(real, 'work', 'temp', 'victim.png')), true);
});

test('repair puts back an original a placement left away from its path, from its backup, and drops every note', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const gone = path.join(dir, 'video.mp4'), present = path.join(dir, 'kept.png');
  await writeFile(gone, 'the only copy'); await writeFile(present, 'still here');
  const backup = (await workdir.backup(gone, { move: true }))!, other = (await workdir.backup(present))!;
  await workdir.journal(gone, backup);
  await workdir.journal(present, other);
  // A note may only name a backup inside the backups folder.
  const outside = path.join(dir, 'elsewhere.bin');
  await writeFile(outside, 'not a backup');
  await workdir.journal(path.join(dir, 'planted.txt'), outside);
  assert.deepEqual(await workdir.repair(), [gone]);
  assert.equal(await readFile(gone, 'utf8'), 'the only copy');
  assert.equal(await readFile(backup, 'utf8'), 'the only copy', 'the backup stays');
  assert.equal(await readFile(present, 'utf8'), 'still here');
  assert.equal(await exists(path.join(dir, 'planted.txt')), false);
  assert.deepEqual(await readdir(path.join(workdir.root, 'placing')), []);
});

test('repair keeps the note of an original it could not put back yet, and finishes at the next start', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const drive = path.join(dir, 'drive'), gone = path.join(drive, 'video.mp4');
  await mkdir(drive); await writeFile(gone, 'the only copy');
  const backup = (await workdir.backup(gone, { move: true }))!;
  await workdir.journal(gone, backup);
  // The folder is not there at this start (a drive that is not connected yet), and a month passes before the next one.
  await rm(drive, { recursive: true }); await writeFile(drive, 'in the way');
  assert.deepEqual(await workdir.repair(), []);
  assert.equal((await readdir(path.join(workdir.root, 'placing'))).length, 1, 'the note stays');
  assert.equal(await workdir.cleanup(DAY, later(30)), 0, 'and so does the backup it names');
  assert.equal(await exists(backup), true);
  await rm(drive); await mkdir(drive);
  assert.deepEqual(await workdir.repair(), [gone]);
  assert.equal(await readFile(gone, 'utf8'), 'the only copy');
  assert.deepEqual(await readdir(path.join(workdir.root, 'placing')), []);
});

test('the cleaner leaves the backup a note names, so a start after a long stop can still put the original back', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-noted-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const gone = path.join(dir, 'video.mp4'), spare = path.join(dir, 'spare.mp4');
  await writeFile(gone, 'the only copy'); await writeFile(spare, 'a plain backup');
  const backup = (await workdir.backup(gone, { move: true }))!, plain = (await workdir.backup(spare))!;
  await workdir.journal(gone, backup);
  // The next start comes a month later: the cleaner would take both backups were it not for the note.
  assert.equal(await workdir.cleanup(DAY, later(30)), 1);
  assert.equal(await exists(backup), true);
  assert.equal(await exists(plain), false);
  assert.deepEqual(await workdir.repair(), [gone]);
  assert.equal(await readFile(gone, 'utf8'), 'the only copy');
});

test('a moved backup that a FAT or exFAT drive left looking old is copied afresh, so the cleaner sees it as just arrived', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-arrival-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'video-1234.mp4'), old = new Date(2020, 0, 1);
  await writeFile(file, 'the only copy'); await utimes(file, old, old);
  const before = await stat(file);
  // As exFAT reports a moved file: every time as old as the file.
  await stampArrival(file, Date.now(), async () => ({ mtimeMs: old.getTime(), ctimeMs: old.getTime(), birthtimeMs: old.getTime() }));
  const after = await stat(file);
  assert.notEqual(after.ino, before.ino, 'a new file under the same name');
  assert.equal(await readFile(file, 'utf8'), 'the only copy');
  assert.equal(after.mtimeMs, old.getTime(), 'the modification time that restoring gives back stays');
  assert.deepEqual((await readdir(dir)), ['video-1234.mp4']);
  // On NTFS the move itself updates the change time: nothing is copied.
  await stampArrival(file);
  assert.equal((await stat(file)).ino, after.ino);
});
