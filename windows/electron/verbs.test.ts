import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURL } from '../core/ipc/protocol';
import { EXPLORER_DOWNSCALE, explorerRequest, skippedNote, stripAll, stripSummary, usableFiles } from './verbs';

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
