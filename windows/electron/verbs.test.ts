import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURL } from '../core/ipc/protocol';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXPLORER_DOWNSCALE, expandFolders, explorerRequest, failureName, skippedNote, stripAll, stripSummary, usableFiles, verbNotes } from './verbs';

test('each verb takes the files of the types it works on and counts the rest', () => {
  const files = ['C:\\a.png', 'C:\\b.mp4', 'C:\\c.mp3', 'C:\\d.pdf', 'C:\\e.txt'];
  assert.deepEqual(usableFiles('optimise', files), { use: files.slice(0, 4), skipped: 1 });
  assert.deepEqual(usableFiles('downscale', files), { use: ['C:\\a.png', 'C:\\b.mp4', 'C:\\c.mp3'], skipped: 2 });
  assert.deepEqual(usableFiles('strip-exif', files), { use: ['C:\\a.png', 'C:\\b.mp4'], skipped: 3 });
});

test('optimise, aggressive and downscale become the request of `clop <verb> --gui`: in place, with a card', () => {
  const files = ['C:\\Pictures\\a b.png', 'C:\\--aggressive.png'];
  const plain = explorerRequest('optimise', files, 'x');
  assert.deepEqual(plain.urls, files.map(fileURL), 'every file, as a file: URL, including one named like an option');
  assert.equal(plain.hideFloatingResult, false);
  assert.equal(plain.aggressiveOptimisation, false);
  assert.equal(plain.downscaleFactor, undefined);
  assert.equal(plain.output, undefined, 'no output template: the file is replaced in place by the usual placement');
  assert.equal(explorerRequest('aggressive', files, 'x').aggressiveOptimisation, true);
  const down = explorerRequest('downscale', files, 'x');
  assert.equal(down.downscaleFactor, EXPLORER_DOWNSCALE);
  assert.equal(down.aggressiveOptimisation, false);
});

test('stripping goes file by file, keeps going after a failure and says what happened', async () => {
  const seen: string[] = [];
  const result = await stripAll(['a.jpg', 'b.jpg', 'c.jpg'], async file => { seen.push(file); if (file === 'b.jpg') throw new Error('exiftool wrote nothing'); });
  assert.deepEqual(seen, ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.deepEqual(result, { done: 2, failed: [{ file: 'b.jpg', reason: 'exiftool wrote nothing' }] });
  assert.equal(stripSummary(result, 0), 'Removed metadata from 2 files.\nb.jpg: exiftool wrote nothing');
  assert.equal(stripSummary({ done: 1, failed: [] }, 2), `Removed metadata from 1 file.\n${skippedNote(2)}`);
  const many = { done: 0, failed: ['a', 'b', 'c', 'd', 'e'].map(file => ({ file: `C:\\x\\${file}.jpg`, reason: 'no' })) };
  assert.equal(stripSummary(many, 0), 'a.jpg: no\nb.jpg: no\nc.jpg: no\n2 more failed.');
});

test('Send To on a folder works on the media files in it, as `clop optimise` does', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-verbs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'shots');
  await mkdir(path.join(folder, 'sub'), { recursive: true });
  for (const name of ['b.png', 'a.jpg', 'notes.txt']) await writeFile(path.join(folder, name), 'x');
  await writeFile(path.join(folder, 'sub', 'deep.png'), 'x');
  const single = path.join(dir, 'one.mp4');
  await writeFile(single, 'x');
  const expanded = await expandFolders([single, folder, path.join(dir, 'gone.png')]);
  assert.deepEqual(expanded, [single, path.join(folder, 'a.jpg'), path.join(folder, 'b.png'), path.join(dir, 'gone.png')], 'one level, media only, in order; a missing file is left for the usual notice');
  assert.equal(usableFiles('optimise', expanded).skipped, 0, 'every file in it counts');
});

test('a notice names a file as it is called, not as its URL spells it', () => {
  assert.equal(failureName(fileURL(path.join(os.tmpdir(), 'a b#c.png'))), 'a b#c.png');
  assert.equal(failureName('https://example.com/pics/a%20b.png?x=1'), 'a b.png');
});

test('a downscale of video or audio, which shows no card, says what it did; the rest is failures and files left out', () => {
  assert.deepEqual(verbNotes({ verb: 'downscale', done: ['C:\\a.mp4', 'C:\\b.png', 'C:\\c.mp3'], failures: ['x.png: no'], skipped: 1 }), ['Downscaled 2 video or audio files.', 'x.png: no', skippedNote(1)]);
  assert.deepEqual(verbNotes({ verb: 'downscale', done: ['C:\\a.mp4'], failures: [], skipped: 0 }), ['Downscaled 1 video or audio file.']);
  assert.deepEqual(verbNotes({ verb: 'optimise', done: ['C:\\a.mp4'], failures: ['1', '2', '3', '4', '5'], skipped: 0 }), ['1', '2', '3', '2 more failed.'], 'optimise shows cards, so it adds nothing');
});
