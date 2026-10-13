import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandDroppedFolders, splitFolders } from './dropped';

async function tree(t: TestContext, files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-dropped-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}
const rel = (dir: string, files: string[]) => files.map(file => path.relative(dir, file).split(path.sep).join('/'));

test('splits a drop into folders and files, and refuses anything that is not a list of absolute paths', async t => {
  const dir = await tree(t, { 'holiday.png/a.jpg': 'a', 'b.png': 'b' });
  const split = await splitFolders([path.join(dir, 'b.png'), path.join(dir, 'holiday.png'), path.join(dir, 'gone.png')]);
  assert.deepEqual([rel(dir, split!.folders), rel(dir, split!.files)], [['holiday.png'], ['b.png', 'gone.png']], 'a folder named like an image is still a folder');
  assert.equal(await splitFolders('x'), undefined);
  assert.equal(await splitFolders(['relative.png']), undefined);
  assert.equal(await splitFolders([1]), undefined);
});

test('replaces a folder with every supported file inside it, recursively, and keeps the dropped files first', async t => {
  const dir = await tree(t, { 'pics/a.png': 'a', 'pics/notes.txt': 'n', 'pics/sub/b.mp4': 'bb', 'pics/.hidden.png': 'h', 'single.pdf': 's' });
  const { files, notices } = await expandDroppedFolders([path.join(dir, 'pics'), path.join(dir, 'single.pdf'), path.join(dir, 'pics', 'a.png')]);
  assert.deepEqual(rel(dir, files), ['single.pdf', 'pics/a.png', 'pics/sub/b.mp4'], 'a file that is also in the folder is listed once');
  assert.deepEqual(notices, []);
});

test('honours .clopignore rules and leaves out Clop\'s own files', async t => {
  const dir = await tree(t, { 'drop/.clopignore-image': 'raw/\n', 'drop/a.png': 'a', 'drop/raw/c.png': 'c', 'drop/work/w.png': 'w' });
  const { files } = await expandDroppedFolders([path.join(dir, 'drop')], { owns: file => file.startsWith(path.join(dir, 'drop', 'work')) });
  assert.deepEqual(rel(dir, files), ['drop/a.png']);
});

test('says so when a folder holds nothing to optimise or more than the limit', async t => {
  const dir = await tree(t, { 'empty/readme.txt': 'r', 'many/1.png': '1', 'many/2.png': '2', 'many/3.png': '3' });
  const none = await expandDroppedFolders([path.join(dir, 'empty')]);
  assert.deepEqual([none.files, none.notices], [[], ['empty: no images, videos, audio or PDFs to optimise.']]);
  const limited = await expandDroppedFolders([path.join(dir, 'many')], { limit: 2 });
  assert.deepEqual(rel(dir, limited.files), ['many/1.png', 'many/2.png']);
  assert.match(limited.notices[0], /^many: only the first/);
});
