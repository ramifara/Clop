import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../core/settings/schema';
import { clipboardChange, clipboardFiles, parseClipboardText, takesFile } from './clipboard';

const settings = defaultSettings();
const all = { ...settings, optimiseVideoClipboard: true, optimisePDFClipboard: true, optimiseAudioClipboard: true, optimiseImagePathClipboard: true };
const owns = (file: string) => file.startsWith('/work/');
const pick = (files: string[], options: { manual?: boolean; bitmap?: boolean; settings?: typeof settings } = {}) =>
  clipboardFiles(files, { manual: options.manual ?? false, bitmap: options.bitmap ?? false, settings: options.settings ?? settings, owns });

test('automatic clipboard optimisation takes each file type only when its setting is on, as macOS does by default', () => {
  const files = ['/a/photo.png', '/a/clip.mp4', '/a/doc.pdf', '/a/song.mp3'];
  // A copied file is a reference: by default only image data beside an image file makes it an image to optimise.
  assert.deepEqual(pick(files), { files: [], media: true });
  assert.deepEqual(pick(files, { bitmap: true }).files, ['/a/photo.png']);
  assert.deepEqual(pick(files, { settings: all }).files, files);
  for (const [key, file] of [['optimiseVideoClipboard', '/a/clip.mp4'], ['optimisePDFClipboard', '/a/doc.pdf'], ['optimiseAudioClipboard', '/a/song.mp3'], ['optimiseImagePathClipboard', '/a/photo.png']] as const)
    assert.deepEqual(pick(files, { settings: { ...settings, [key]: true } }).files, [file], key);
});
test('skips formats listed as never optimised automatically, under any of their extensions', () => {
  assert.deepEqual(pick(['/a/scan.tif', '/a/scan.TIFF', '/a/movie.mkv', '/a/movie.m4v', '/a/clip.mov'], { settings: all }).files, ['/a/clip.mov']);
  assert.equal(takesFile('audio', '/a/take.aif', { ...all, audioFormatsToSkip: ['aiff'] }), false);
  assert.equal(takesFile('image', '/a/photo.jpg', { ...all, imageFormatsToSkip: ['jpeg'] }), false);
});
test('a manual optimisation takes every media file; neither takes copy temporaries or other files', () => {
  const files = ['/a/scan.tiff', '/a/movie.mkv', '/work/temp/result.png', '/a/.clop-1234.tmp', '/a/notes.txt', '/a/archive.zip'];
  assert.deepEqual(pick(files, { manual: true }), { files: ['/a/scan.tiff', '/a/movie.mkv', '/work/temp/result.png'], media: true });
  assert.deepEqual(pick(files, { settings: all }), { files: [], media: true });
  assert.deepEqual(pick(['/a/notes.txt', '/a/.clop-1.tmp']), { files: [], media: false });
  // Clop's own results are never optimised again automatically.
  assert.deepEqual(pick(['/work/temp/session/1/clip.mp4', '/a/clip.mp4'], { settings: all }).files, ['/a/clip.mp4']);
});
test('reads copied data-URL images, absolute paths and links', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  assert.deepEqual(parseClipboardText(`data:image/png;base64,${png.toString('base64')}`), { type: 'image', bytes: png, ext: 'png' });
  assert.deepEqual(parseClipboardText(` url("data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}") `), { type: 'image', bytes: Buffer.from('<svg/>'), ext: 'svg' });
  assert.equal(parseClipboardText('data:image/png;base64,'), undefined);
  assert.equal(parseClipboardText('data:text/plain;base64,aGVsbG8='), undefined);
  assert.deepEqual(parseClipboardText('"C:\\Users\\me\\Videos\\clip.mp4"', 'win32'), { type: 'path', path: 'C:\\Users\\me\\Videos\\clip.mp4' });
  assert.deepEqual(parseClipboardText('\\\\server\\share\\scan.pdf', 'win32'), { type: 'path', path: '\\\\server\\share\\scan.pdf' });
  assert.deepEqual(parseClipboardText('file:///C:/Users/me/song%20one.mp3', 'win32'), { type: 'path', path: 'C:\\Users\\me\\song one.mp3' });
  assert.deepEqual(parseClipboardText('/home/me/photo.png', 'linux'), { type: 'path', path: '/home/me/photo.png' });
  assert.deepEqual(parseClipboardText('https://example.com/a b.png'.replace(' ', '%20')), { type: 'url', url: 'https://example.com/a%20b.png' });
  for (const text of ['', 'photo.png', '\\photo.png', 'C:photo.png', '/home/me/a.png\n/home/me/b.png', 'ftp://example.com/a.png', 'see https://example.com/a.png', 'javascript:alert(1)'])
    assert.equal(parseClipboardText(text, text.startsWith('/') ? 'linux' : 'win32'), undefined, text);
});
test('checks every field of a clipboard change from the Windows helper', () => {
  const change = { type: 'clipboard', sequence: 42, paths: ['/a/clip.mp4'], image: false, bitmap: false, text: true, process: 1234, app: 'explorer' };
  assert.deepEqual(clipboardChange(change), { sequence: 42, paths: ['/a/clip.mp4'], image: false, bitmap: false, text: true, process: 1234, app: 'explorer' });
  assert.deepEqual(clipboardChange({ type: 'reply', id: 'x', ok: true, sequence: 7, paths: [], bitmap: true, owned: true, transient: false }), { sequence: 7, paths: [], image: false, bitmap: true, text: false, owned: true, transient: false });
  for (const bad of [null, 'x', { ...change, sequence: -1 }, { ...change, sequence: 1.5 }, { ...change, sequence: '42' }, { ...change, paths: '/a/clip.mp4' }, { ...change, paths: ['clip.mp4'] },
    { ...change, paths: [''] }, { ...change, paths: [1] }, { ...change, paths: Array(65).fill('/a/b.png') }, { ...change, bitmap: 'yes' }, { ...change, owned: 1 }, { ...change, process: 'x' }, { ...change, app: 3 }])
    assert.equal(clipboardChange(bad), undefined, JSON.stringify(bad)?.slice(0, 80));
});
