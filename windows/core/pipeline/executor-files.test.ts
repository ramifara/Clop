import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { graphic } from '../media/image.fixtures';
import { pipelineWorkspace, quoted } from './executor.fixtures';

const year = String(new Date().getFullYear());

test('copy, move and rename resolve templates, captures and folders, and carry on with the new file', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('shot-12.png');
  await graphic(40, 30).png().toFile(input);
  const copied = await w.run('if(regex: "^(shot)-(\\d+)") -> copy(to: "%P/copies/$2-%f-%y")', input);
  assert.equal(copied.file, path.join(w.files, 'copies', `12-shot-12-${year}.png`));
  assert.deepEqual(await readFile(copied.file), await readFile(input));

  const moved = await w.run(`move(to: ${quoted(path.join(w.dir, 'sorted') + '/')}) -> rename(to: "%f-done")`, copied.file);
  assert.equal(moved.file, path.join(w.dir, 'sorted', `12-shot-12-${year}-done.png`), 'the template tokens name the file the run started with');
  assert.deepEqual(await readdir(path.join(w.files, 'copies')), []);

  // A name the template gives with a known extension keeps it; a dotted name without one gets the file's.
  const renamed = await w.run('rename(to: "Screenshot 10.32.11")', moved.file);
  assert.equal(renamed.file, path.join(w.dir, 'sorted', 'Screenshot 10.32.11.png'));
  const relative = await w.run('copy(to: "backup/keep.png")', renamed.file);
  assert.equal(relative.file, path.join(w.dir, 'sorted', 'backup', 'keep.png'), 'a relative destination lands next to the file');
});

test('a file in the way of a move is kept in the backups', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('a.png'), other = w.file('b.png');
  await graphic(40, 30).png().toFile(input);
  await writeFile(other, 'someone else');
  await w.run('rename(to: "b")', input);
  assert.deepEqual(await readdir(w.files), ['b.png']);
  const [backup] = await w.backups();
  assert.equal(await readFile(path.join(w.workdir.backups, backup), 'utf8'), 'someone else');
});

test('delete sends the source file or a templated path to the Recycle Bin', async t => {
  const w = await pipelineWorkspace(t, 'pngquant'); if (!w) return;
  const input = w.file('photo.png');
  await graphic(80, 60).png().toFile(input);
  const result = await w.run('convert(to: webp) -> delete(path: "sourceFile")', input);
  assert.equal(result.file, w.file('photo.webp'));
  assert.deepEqual(w.effects.trashed, [[input, 'file']]);
  await mkdir(w.file('photo-assets'));
  await w.run('delete(path: "%P/%f-assets")', result.file);
  assert.deepEqual(w.effects.trashed.at(-1), [w.file('photo-assets'), 'folder']);
});

test('filters stop the pipeline quietly when they do not match', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('keep-me.png');
  await graphic(80, 60).png().toFile(input);
  const skipped = await w.run('if(types: jpeg) -> delete(path: "sourceFile")', input);
  assert.deepEqual([skipped.stopped, skipped.didWork, skipped.file], [true, false, input]);
  const excluded = await w.run('ifNot(nameContains: "keep") -> delete(path: "sourceFile")', input);
  assert.equal(excluded.stopped, true);
  const copiedBy = await w.run('if(copiedBy: "paint") -> copy(to: "x/")', input, { sourceApp: { name: 'Paint' } });
  assert.deepEqual([copiedBy.stopped, copiedBy.didWork], [false, true]);
  assert.deepEqual(w.effects.trashed, []);
});
