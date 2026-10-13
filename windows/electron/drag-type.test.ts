import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { batchKind } from '../core/batch/scan';
import { DragType, dragTypeOf, type DragTypeOptions } from './drag-type';

async function folder(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clop-dragtype-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }
  return root;
}
const options: DragTypeOptions = { kindOf: batchKind };

test('a folder of images is a drag of images, subfolders included', async t => {
  const root = await folder(t, { 'a.png': 'x', 'b.jpg': 'x', 'trip/c.webp': 'x', 'notes.txt': 'x' });
  assert.equal(await dragTypeOf([root], options), 'image', 'files Clop does not take inside a folder do not count');
  assert.equal(await dragTypeOf([root, path.join(root, 'a.png')], options), 'image', 'with a dragged image beside it');
  assert.equal(await dragTypeOf([root, path.join(root, 'notes.txt')], options), undefined, 'a dragged file Clop does not take');
  assert.equal(await dragTypeOf([path.join(root, 'a.png'), path.join(root, 'b.jpg')], options), 'image', 'files alone, by their names');
});

test('a folder of several types, or of nothing Clop takes, has no type', async t => {
  const mixed = await folder(t, { 'a.png': 'x', 'clip.mp4': 'x' }), empty = await folder(t, { 'readme.md': 'x' });
  assert.equal(await dragTypeOf([mixed], options), undefined);
  assert.equal(await dragTypeOf([empty], options), undefined);
  assert.equal(await dragTypeOf([mixed, empty], options), undefined);
});

test('hidden files, .clopignore rules, Clop\'s own files and cloud-only files are left out, as a drop leaves them out', async t => {
  const root = await folder(t, { 'a.png': 'x', '.hidden.mp4': 'x', '.secret/b.mp4': 'x', 'raw/c.mp4': 'x', '.clopignore-video': 'raw/\n', 'own/d.mp3': 'x', 'cloud.mov': 'x' });
  assert.equal(await dragTypeOf([root], { ...options, owns: file => file.includes(`${path.sep}own`), isLocal: async file => !file.endsWith('cloud.mov') }), 'image');
  assert.equal(await dragTypeOf([root], options), undefined, 'without the cloud check the placeholder video counts');
});

test('looking inside is bounded: a huge folder gets the type of what was looked at', async t => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i++) files[`img-${String(i).padStart(3, '0')}.png`] = 'x';
  files['zz-clip.mp4'] = 'x';
  const root = await folder(t, files);
  assert.equal(await dragTypeOf([root], { ...options, maxEntries: 10 }), 'image');
  assert.equal(await dragTypeOf([root], options), undefined, 'the default bound reaches the video');
});

test('links inside a dragged folder are not followed', async t => {
  const root = await folder(t, { 'photos/a.png': 'x', 'videos/clip.mp4': 'x' });
  try { await symlink(path.join(root, 'videos'), path.join(root, 'photos', 'more'), 'junction'); } catch { t.skip('links cannot be made here'); return; }
  assert.equal(await dragTypeOf([path.join(root, 'photos')], options), 'image');
});

test('a dragged folder\'s type arrives after the drag starts, and is dropped with the drag', async t => {
  const root = await folder(t, { 'a.png': 'x', 'b.png': 'x' });
  let changes = 0;
  const drag = new DragType(() => options, () => { changes++; });
  await drag.start([path.join(root, 'a.png')]);
  assert.deepEqual([drag.type, changes], ['image', 0], 'files get their type at once');
  const looking = drag.start([root]);
  assert.equal(drag.type, undefined, 'until the folder is looked through, only the zones for any type show');
  await looking;
  assert.deepEqual([drag.type, changes], ['image', 1], 'then the grid is told');
  // A drag that ends, or a new drag, before the look finishes is not changed by it.
  const stale = drag.start([root]);
  drag.end();
  await stale;
  assert.deepEqual([drag.type, changes], [undefined, 1]);
  const first = drag.start([root]), second = drag.start([path.join(root, 'a.png'), path.join(root, 'missing.txt')]);
  await Promise.all([first, second]);
  assert.deepEqual([drag.type, changes], [undefined, 1], 'the newer drag wins');
});
