import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ToolError } from '../run';
import { needTools } from '../testing';
import { closeExifTool, endStaleExifTool, exiftool, exifToolEnded, keepExifToolRunning, recordExifToolPid, setExifToolIdleMs } from './exiftool';

const read = (stdout: Buffer) => JSON.parse(stdout.toString())[0] as Record<string, unknown>;

test('commands share one waiting process, each getting its own output and status', async t => {
  if (!needTools(t, 'exiftool')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-exiftool-'));
  t.after(async () => { await closeExifTool(); await rm(dir, { recursive: true, force: true }); });
  const a = path.join(dir, 'a.png'), b = path.join(dir, 'b.jpg');
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#f00' } }).png().toFile(a);
  await sharp({ create: { width: 20, height: 10, channels: 3, background: '#0f0' } }).jpeg().toFile(b);
  // Several at once: they are sent in turn, and each answer belongs to its command.
  const [sizeA, sizeB, written] = await Promise.all([
    exiftool(['-j', '-n', '-ImageWidth', '-ImageHeight', a]).then(r => read(r.stdout)),
    exiftool(['-j', '-n', '-ImageWidth', '-ImageHeight', b]).then(r => read(r.stdout)),
    exiftool(['-overwrite_original', '-Artist=Clop', b]),
  ]);
  assert.deepEqual([sizeA.ImageWidth, sizeA.ImageHeight, sizeB.ImageWidth, sizeB.ImageHeight], [40, 30, 20, 10]);
  assert.equal(written.code, 0);
  assert.equal(read((await exiftool(['-j', '-Artist', b])).stdout).Artist, 'Clop');
  // A failure is reported like a process of its own would report it, and the process goes on serving.
  await assert.rejects(exiftool(['-j', path.join(dir, 'missing.png')]), (error: unknown) => error instanceof ToolError && error.exitCode !== 0 && /not found/i.test(error.stderr));
  assert.equal(read((await exiftool(['-j', '-n', '-ImageWidth', a])).stdout).ImageWidth, 40);
  // Output with several lines comes through whole.
  const both = JSON.parse((await exiftool(['-j', '-n', '-ImageWidth', a, b])).stdout.toString()) as { ImageWidth: number }[];
  assert.deepEqual(both.map(entry => entry.ImageWidth), [40, 20]);
});

test('an abort is reported once the command is over, and closing ends the process until the next command', async t => {
  if (!needTools(t, 'exiftool')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-exiftool-'));
  t.after(async () => { await closeExifTool(); await rm(dir, { recursive: true, force: true }); });
  const a = path.join(dir, 'a.png');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00f' } }).png().toFile(a);
  await assert.rejects(exiftool(['-j', a], { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController();
  const running = exiftool(['-j', '-n', '-ImageWidth', a], { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  await closeExifTool();
  assert.equal(read((await exiftool(['-j', '-n', '-ImageWidth', a])).stdout).ImageWidth, 8);
  await closeExifTool();
  // Switched off, every command is a process of its own, and the result is the same.
  keepExifToolRunning(false);
  t.after(() => keepExifToolRunning(true));
  assert.equal(read((await exiftool(['-j', '-n', '-ImageHeight', a])).stdout).ImageHeight, 8);
});

test('a path with a hash, spaces and other scripts survives the argument file', async t => {
  if (!needTools(t, 'exiftool')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-exiftool-'));
  t.after(async () => { await closeExifTool(); await rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'shot #1 (final) Zoë 写真.png');
  await sharp({ create: { width: 12, height: 6, channels: 3, background: '#fff' } }).png().toFile(file);
  await writeFile(path.join(dir, 'ignored.txt'), 'x');
  assert.equal(read((await exiftool(['-charset', 'filename=utf8', '-j', '-n', '-ImageWidth', file])).stdout).ImageWidth, 12);
});

test('a script that only waits for a command is not ended before the answer, and ends once idle', async t => {
  if (!needTools(t, 'exiftool')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-exiftool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.png');
  await sharp({ create: { width: 16, height: 4, channels: 3, background: '#000' } }).png().toFile(file);
  const script = path.join(dir, 'script.mts');
  await writeFile(script, `import { closeExifTool, exiftool } from ${JSON.stringify(path.resolve('core/media/exiftool.ts'))};\nconst { stdout } = await exiftool(['-j', '-n', '-ImageWidth', ${JSON.stringify(file)}]);\nawait closeExifTool();\nconst again = await exiftool(['-j', '-n', '-ImageWidth', ${JSON.stringify(file)}]);\nconsole.log(JSON.parse(stdout.toString())[0].ImageWidth, JSON.parse(again.stdout.toString())[0].ImageWidth);\n`);
  const tsx = path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const { stdout } = await promisify(execFile)(tsx, [script], { timeout: 60_000, shell: process.platform === 'win32' });
  assert.equal(stdout.trim(), '16 16');
});

test('a process left idle ends itself, and the next command starts another', async t => {
  if (!needTools(t, 'exiftool')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-exiftool-'));
  setExifToolIdleMs(300);
  t.after(async () => { setExifToolIdleMs(30_000); await closeExifTool(); await rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'a.png');
  await sharp({ create: { width: 5, height: 5, channels: 3, background: '#000' } }).png().toFile(file);
  assert.equal(read((await exiftool(['-j', '-n', '-ImageWidth', file])).stdout).ImageWidth, 5);
  const ended = exifToolEnded();
  assert.ok(ended, 'a process is waiting after a command');
  // Ends on its own within the idle time, plus what ending takes on a busy machine; nothing asks it to.
  await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('the idle process did not end')), 5000))]);
  assert.equal(exifToolEnded(), undefined);
  // The next command starts a process again and gets its answer.
  assert.equal(read((await exiftool(['-j', '-n', '-ImageHeight', file])).stdout).ImageHeight, 5);
  assert.ok(exifToolEnded());
});

test('the app notes its process in a file, and a stale one from a run that could not close it is ended at the next start', async t => {
  if (!needTools(t, 'exiftool') || process.platform === 'win32') return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-exiftool-'));
  const pidFile = path.join(dir, 'exiftool.pid');
  recordExifToolPid(pidFile);
  t.after(async () => { recordExifToolPid(undefined); await closeExifTool(); await rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'a.png');
  await sharp({ create: { width: 3, height: 3, channels: 3, background: '#fff' } }).png().toFile(file);
  assert.equal(read((await exiftool(['-j', '-n', '-ImageWidth', file])).stdout).ImageWidth, 3);
  await new Promise(resolve => setTimeout(resolve, 200));
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(pid > 0 && pid !== process.pid, 'the process is noted');
  // As a next start would find it: the process is still there, with no one to close it.
  const alive = (id: number) => { try { process.kill(id, 0); return true; } catch { return false; } };
  assert.equal(alive(pid), true);
  const ended = exifToolEnded()!;
  await endStaleExifTool(pidFile);
  await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('the stale process was not ended')), 5000))]);
  assert.equal(await readFile(pidFile, 'utf8').catch(() => undefined), undefined, 'the note is removed');
  // A note of a process that is not exiftool (this one) is left alone.
  await writeFile(pidFile, String(process.pid));
  await endStaleExifTool(pidFile);
  assert.equal(alive(process.pid), true);
});
