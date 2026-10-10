import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rescan, watchTree } from './folder-events';

test('looking again after lost changes runs one scan at a time for every listener, and once more if asked meanwhile, outside folders they all skip', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clop-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.png'), 'x'); await writeFile(path.join(root, 'b.mp4'), 'x');
  await mkdir(path.join(root, 'work')); await writeFile(path.join(root, 'work', 'c.png'), 'x');
  // Let the writes' own notifications pass before listening.
  await new Promise(resolve => setTimeout(resolve, 200));
  const heard: string[][] = [[], []];
  const stops = await Promise.all(heard.map(list => watchTree(root, { file: (file, created) => { if (created) list.push(path.basename(file)); }, lost: () => {}, skip: dir => path.basename(dir) === 'work' })));
  t.after(() => { for (const stop of stops) stop(); });
  await Promise.all([rescan(root), rescan(root), rescan(root)]);
  for (const list of heard) assert.deepEqual(list.sort(), ['a.png', 'a.png', 'b.mp4', 'b.mp4'], 'the first scan, and one more for the requests that came meanwhile');
});
