import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../core/settings/schema';
import { ClipboardIntake, clipboardChange, clipboardFiles, clipboardIntake, copyReply, isLocalPath, parseClipboardText, sequenceReply, takesFile, type ClipboardMemory, type ClipboardSnapshot, type IntakeSources } from './clipboard';

// The macOS defaults; Windows differs only in optimiseImagePathClipboard, checked below.
const settings = { ...defaultSettings(), optimiseImagePathClipboard: false };
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
  // Windows keeps optimising image files copied in Explorer by default.
  assert.deepEqual(pick(files, { settings: defaultSettings() }).files, ['/a/photo.png']);
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
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]), manual = { manual: true };
  const dataURL = `data:image/png;base64,${png.toString('base64')}`;
  assert.deepEqual(parseClipboardText(dataURL, 'linux', manual), { type: 'image', bytes: png, ext: 'png' });
  assert.deepEqual(parseClipboardText(` url("data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}") `, 'linux', manual), { type: 'image', bytes: Buffer.from('<svg/>'), ext: 'svg' });
  // Bare base64 counts when it decodes to an image, as `ClipboardType.fromString` reads it.
  assert.deepEqual(parseClipboardText(png.toString('base64'), 'linux', manual), { type: 'image', bytes: png, ext: 'png' });
  assert.equal(parseClipboardText(Buffer.from('just some words here').toString('base64'), 'linux', manual), undefined);
  assert.equal(parseClipboardText('data:image/png;base64,', 'linux', manual), undefined);
  assert.equal(parseClipboardText('data:text/plain;base64,aGVsbG8=', 'linux', manual), undefined);
  // Automatic optimisation reads only paths: no image decoding, no links, and nothing longer than a path.
  for (const text of [dataURL, png.toString('base64'), 'https://example.com/a.png', `/${'a'.repeat(40_000)}.png`]) assert.equal(parseClipboardText(text, 'linux'), undefined, text.slice(0, 40));
  assert.deepEqual(parseClipboardText('"C:\\Users\\me\\Videos\\clip.mp4"', 'win32'), { type: 'path', path: 'C:\\Users\\me\\Videos\\clip.mp4' });
  assert.deepEqual(parseClipboardText('\\\\server\\share\\scan.pdf', 'win32'), { type: 'path', path: '\\\\server\\share\\scan.pdf' });
  assert.deepEqual(parseClipboardText('file:///C:/Users/me/song%20one.mp3', 'win32'), { type: 'path', path: 'C:\\Users\\me\\song one.mp3' });
  assert.deepEqual(parseClipboardText('/home/me/photo.png', 'linux'), { type: 'path', path: '/home/me/photo.png' });
  assert.deepEqual(parseClipboardText('https://example.com/a b.png'.replace(' ', '%20'), 'linux', manual), { type: 'url', url: 'https://example.com/a%20b.png' });
  for (const text of ['', 'photo.png', '\\photo.png', 'C:photo.png', '/home/me/a.png\n/home/me/b.png', 'ftp://example.com/a.png', 'see https://example.com/a.png', 'javascript:alert(1)'])
    assert.equal(parseClipboardText(text, text.startsWith('/') ? 'linux' : 'win32', manual), undefined, text);
});
test('checks every field of a clipboard change from the Windows helper', () => {
  const change = { type: 'clipboard', sequence: 42, paths: ['/a/clip.mp4'], image: false, bitmap: false, text: true, process: 1234, app: 'explorer' };
  assert.deepEqual(clipboardChange(change), { sequence: 42, paths: ['/a/clip.mp4'], image: false, bitmap: false, text: true, process: 1234, app: 'explorer' });
  assert.deepEqual(clipboardChange({ type: 'reply', id: 'x', ok: true, sequence: 7, paths: [], bitmap: true, owned: true, transient: false }), { sequence: 7, paths: [], image: false, bitmap: true, text: false, owned: true, transient: false });
  for (const bad of [null, 'x', { ...change, sequence: -1 }, { ...change, sequence: 1.5 }, { ...change, sequence: '42' }, { ...change, paths: '/a/clip.mp4' }, { ...change, paths: ['clip.mp4'] },
    { ...change, paths: [''] }, { ...change, paths: [1] }, { ...change, paths: Array(65).fill('/a/b.png') }, { ...change, bitmap: 'yes' }, { ...change, owned: 1 }, { ...change, process: 'x' }, { ...change, app: 3 }])
    assert.equal(clipboardChange(bad), undefined, JSON.stringify(bad)?.slice(0, 80));
});
test('replies from the Windows helper are checked before use', () => {
  assert.equal(sequenceReply({ type: 'reply', ok: true, sequence: 12 }), 12);
  assert.deepEqual(copyReply({ ok: true, skipped: true }), { skipped: true });
  assert.deepEqual(copyReply({ ok: true, sequence: 9 }), { skipped: false, sequence: 9 });
  for (const bad of [null, {}, { sequence: -1 }, { sequence: '12' }, { sequence: 1.5 }]) assert.throws(() => sequenceReply(bad), /unreadable/);
  for (const bad of [null, { skipped: 'yes' }, { skipped: false }, { sequence: NaN }]) assert.throws(() => copyReply(bad), /unreadable/);
});

/** Clipboard sources that record every file-system look-up. */
function sources(state: { snapshots?: (ClipboardSnapshot | undefined)[]; text?: string; image?: Buffer; files?: string[]; settings?: typeof settings }) {
  const looked: string[] = [], calls = { text: 0 };
  const snapshots = state.snapshots ?? [];
  const value: IntakeSources = {
    settings: state.settings ?? settings, owns: file => file.startsWith('/work/') || file.startsWith('C:\\work\\'), platform: 'win32',
    read: async () => snapshots.length > 1 ? snapshots.shift() : snapshots[0],
    image: async () => state.image ?? Buffer.alloc(0),
    text: async () => { calls.text++; return state.text ?? ''; },
    isFile: async file => { looked.push(file); return (state.files ?? []).includes(file); },
    fingerprint: async files => { looked.push(...files); return files.join('|'); },
    hash: bytes => bytes.toString('hex'),
  };
  return { value, looked, calls };
}
const change = (sequence: number, more: Partial<ClipboardSnapshot> = {}): ClipboardSnapshot => ({ sequence, paths: [], image: false, bitmap: false, text: true, ...more });
const memory = (): ClipboardMemory => ({ fingerprint: '', own: '' });

test('automatic optimisation never looks up network or device paths, or paths its settings leave alone', async () => {
  assert.equal(isLocalPath('C:\\Users\\me\\clip.mp4', 'win32'), true);
  for (const remote of ['\\\\host\\share\\clip.mp4', '\\\\.\\pipe\\clip.mp4', '\\\\?\\C:\\clip.mp4', '//host/share/clip.mp4']) assert.equal(isLocalPath(remote, 'win32'), false, remote);
  for (const text of ['\\\\attacker\\share\\clip.mp4', 'file://attacker/share/clip.mp4', '\\\\?\\C:\\clip.mp4', '\\\\.\\pipe\\x.mp4', 'C:\\work\\temp\\clip.mp4']) {
    const s = sources({ snapshots: [change(1)], text, settings: { ...settings, optimiseVideoClipboard: true } });
    assert.deepEqual(await clipboardIntake(undefined, false, memory(), s.value), { type: 'none' }, text);
    assert.deepEqual(s.looked, [], text);
  }
  // A local path whose type is off is not looked up either.
  const off = sources({ snapshots: [change(1)], text: 'C:\\Videos\\clip.mp4' });
  assert.deepEqual(await clipboardIntake(undefined, false, memory(), off.value), { type: 'none' });
  assert.deepEqual(off.looked, []);
  // With no type setting on, automatic text copies are not even read.
  const quiet = sources({ snapshots: [change(1)], text: 'C:\\Pictures\\a.png' });
  await clipboardIntake(undefined, false, memory(), quiet.value);
  assert.equal(quiet.calls.text, 0);
  // A manual optimisation is an explicit request, so it may reach a share.
  const manual = sources({ snapshots: [change(1)], text: '\\\\nas\\share\\clip.mp4', files: ['\\\\nas\\share\\clip.mp4'] });
  assert.deepEqual(await clipboardIntake(undefined, true, memory(), manual.value), { type: 'files', files: ['\\\\nas\\share\\clip.mp4'], sequence: 1, text: true });
});
test('a copied path that is re-read after the clipboard moved on is still optimised', async () => {
  const text = 'C:\\Videos\\clip.mp4', remembered = memory(), all = { ...settings, optimiseVideoClipboard: true };
  // The clipboard changes again while it is read: look at the newer change instead, without remembering the path yet.
  const first = sources({ snapshots: [change(2)], text, files: [text], settings: all });
  assert.deepEqual(await clipboardIntake(change(1), false, remembered, first.value), { type: 'retry', change: change(2) });
  const second = sources({ snapshots: [change(2)], text, files: [text], settings: all });
  assert.deepEqual(await clipboardIntake(change(2), false, remembered, second.value), { type: 'files', files: [text], sequence: 2, text: true });
  // The same copy is not optimised twice, but text in between lets it be optimised again.
  assert.deepEqual(await clipboardIntake(change(3), false, remembered, second.value), { type: 'none' });
  assert.deepEqual(await clipboardIntake(change(4), false, remembered, sources({ snapshots: [change(4)], text: 'hello', settings: all }).value), { type: 'none' });
  assert.deepEqual((await clipboardIntake(change(5), false, remembered, sources({ snapshots: [change(5)], text, files: [text], settings: all }).value)).type, 'files');
});
test('a manual optimisation reads image data, data URLs and links; an automatic one only image data', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)]);
  assert.deepEqual(await clipboardIntake(undefined, true, memory(), sources({ snapshots: [change(1, { text: true })], text: `data:image/png;base64,${png.toString('base64')}` }).value), { type: 'image', bytes: png, ext: 'png', sequence: 1 });
  assert.deepEqual(await clipboardIntake(undefined, true, memory(), sources({ snapshots: [change(1)], text: 'https://example.com/clip.mp4' }).value), { type: 'url', url: 'https://example.com/clip.mp4' });
  assert.deepEqual(await clipboardIntake(undefined, false, memory(), sources({ snapshots: [change(1)], text: 'https://example.com/clip.mp4', settings: defaultSettings() }).value), { type: 'none' });
  const pixels = sources({ snapshots: [change(1, { bitmap: true, text: false })], image: png });
  assert.deepEqual(await clipboardIntake(undefined, false, memory(), pixels.value), { type: 'image', bytes: png, ext: 'png', sequence: 1 });
  assert.equal((await clipboardIntake(undefined, true, memory(), sources({ snapshots: [change(1)], text: 'nothing' }).value)).type, 'none');
});
test('clipboard reads run one at a time and never wait for a running import or drop a request', async () => {
  const order: string[] = [], errors: unknown[] = [];
  const intake = new ClipboardIntake(error => errors.push(error));
  let finishVideo!: () => void;
  const video = new Promise<void>(resolve => { finishVideo = resolve; });
  const read = (name: string, work?: () => Promise<unknown>) => intake.submit(async () => { order.push(`read ${name}`); await new Promise(resolve => setTimeout(resolve, 5)); return work; });
  void read('video', async () => { await video; order.push('video done'); });
  void read('screenshot', async () => { order.push('screenshot done'); });
  void read('text');
  void read('manual', async () => { throw new Error('manual failed'); });
  await read('last');
  assert.deepEqual(order, ['read video', 'read screenshot', 'screenshot done', 'read text', 'read manual', 'read last']);
  finishVideo();
  await intake.idle();
  assert.deepEqual(order.at(-1), 'video done');
  assert.deepEqual(errors.map(error => (error as Error).message), ['manual failed']);
});
