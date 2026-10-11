import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { batchKind, scanBatch } from './scan';

async function tree(t: TestContext, files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-scan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}
const names = (dir: string, files: { path: string }[]) => files.map(file => path.relative(dir, file.path).split(path.sep).join('/'));

test('types files by extension and leaves out what a batch cannot take', () => {
  assert.equal(batchKind('a/Photo.JPG'), 'image');
  assert.equal(batchKind('clip.mov'), 'video');
  assert.equal(batchKind('doc.pdf'), 'pdf');
  assert.equal(batchKind('song.flac'), 'audio');
  assert.equal(batchKind('notes.txt'), undefined);
  assert.equal(batchKind('no-extension'), undefined);
});

test('walks dropped folders with every subfolder, skipping hidden, unsupported and duplicate files', async t => {
  const dir = await tree(t, {
    'top/a.png': 'a', 'top/b.txt': 'b', 'top/.hidden.png': 'h', 'top/sub/c.mp4': 'cc', 'top/sub/deeper/d.pdf': 'ddd', 'top/.cache/e.png': 'e', 'single.mp3': 'mmmm',
  });
  const { files, truncated } = await scanBatch([path.join(dir, 'top'), path.join(dir, 'single.mp3'), path.join(dir, 'top', 'a.png'), path.join(dir, 'missing.png')]);
  assert.equal(truncated, false);
  assert.deepEqual(names(dir, files), ['top/a.png', 'top/sub/c.mp4', 'top/sub/deeper/d.pdf', 'single.mp3']);
  assert.deepEqual(files.map(file => [file.kind, file.bytes, file.format]), [['image', 1, 'PNG'], ['video', 2, 'MP4'], ['pdf', 3, 'PDF'], ['audio', 4, 'MP3']]);
});

test('honours the .clopignore-<type> rules at the top of a dropped folder, for that type only', async t => {
  const dir = await tree(t, {
    'drop/.clopignore-image': 'raw/\n*.gif\n!keep.gif\n', 'drop/a.png': 'a', 'drop/b.gif': 'b', 'drop/keep.gif': 'k', 'drop/raw/c.png': 'c', 'drop/raw/d.mp4': 'd',
  });
  const { files } = await scanBatch([path.join(dir, 'drop')]);
  assert.deepEqual(names(dir, files), ['drop/a.png', 'drop/keep.gif', 'drop/raw/d.mp4']);
});

test('leaves out Clop\'s own files and stops at the limit', async t => {
  const dir = await tree(t, { 'drop/1.png': '1', 'drop/2.png': '2', 'drop/3.png': '3', 'drop/work/backup.png': 'w' });
  const owns = (file: string) => file.startsWith(path.join(dir, 'drop', 'work'));
  assert.deepEqual(names(dir, (await scanBatch([path.join(dir, 'drop')], { owns })).files), ['drop/1.png', 'drop/2.png', 'drop/3.png']);
  const limited = await scanBatch([path.join(dir, 'drop')], { owns, limit: 2 });
  assert.deepEqual([names(dir, limited.files), limited.truncated], [['drop/1.png', 'drop/2.png'], true]);
});

test('does not follow links inside a dropped folder', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async t => {
  const dir = await tree(t, { 'drop/a.png': 'a', 'outside/b.png': 'b' });
  await symlink(path.join(dir, 'outside'), path.join(dir, 'drop', 'link'));
  assert.deepEqual(names(dir, (await scanBatch([path.join(dir, 'drop')])).files), ['drop/a.png']);
});

test('stops looking after a number of folders and files, whatever they are, and says so', async t => {
  const junk = Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`drop/z${String(n).padStart(2, '0')}/note.txt`, 'n']));
  const dir = await tree(t, { ...junk, 'drop/zzz/late.png': 'p', 'drop/early.png': 'e' });
  const all = await scanBatch([path.join(dir, 'drop')]);
  assert.deepEqual([names(dir, all.files), all.entriesCapped], [['drop/early.png', 'drop/zzz/late.png'], false]);
  const capped = await scanBatch([path.join(dir, 'drop')], { maxEntries: 20 });
  assert.equal(capped.entriesCapped, true);
  assert.deepEqual(names(dir, capped.files), ['drop/early.png'], 'what was found before the cap is kept');
});

test('leaves out cloud-only placeholders without reading them, and counts them', async t => {
  const dir = await tree(t, { 'drop/a.png': 'a', 'drop/b.png': 'b', 'drop/c.mp4': 'c', 'lone.pdf': 'l' });
  const asked: string[] = [];
  const cloud = new Set(['b.png', 'lone.pdf']);
  const isLocal = async (file: string) => { asked.push(path.basename(file)); return !cloud.has(path.basename(file)); };
  const result = await scanBatch([path.join(dir, 'drop'), path.join(dir, 'lone.pdf')], { isLocal });
  assert.deepEqual(names(dir, result.files), ['drop/a.png', 'drop/c.mp4']);
  assert.equal(result.cloud, 2);
  assert.deepEqual(asked.sort(), ['a.png', 'b.png', 'c.mp4', 'lone.pdf']);
});
