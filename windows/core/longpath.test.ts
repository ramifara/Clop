import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { graphic } from './media/image.fixtures';
import { optimiseImage } from './media/image';
import { optimiseVideo } from './media/video';
import { probe } from './media/detect';
import { clip } from './media/video.fixtures';
import { optimisePDF } from './media/pdf';
import { photoPDF } from './media/pdf.fixtures';
import { needTools } from './testing';
import { extendedArgument, extendedPath, LONG_PATH, plainPath, toolArguments } from './longpath';

const deep = (root: string, sep: string, length: number) => { let file = root; for (let n = 0; file.length < length; n++) file += `${sep}${'folder'.repeat(5)}${n}`; return `${file}${sep}photo.png`; };
const drive = deep('C:\\Users\\me\\Pictures', '\\', 300), unc = deep('\\\\nas\\photos', '\\', 300);

test('a drive path over the limit gets the extended prefix, a UNC path its UNC form', () => {
  assert.ok(drive.length > 260 && unc.length > 260);
  assert.equal(extendedPath(drive, 'win32'), `\\\\?\\${drive}`);
  assert.equal(extendedPath(unc, 'win32'), `\\\\?\\UNC\\${unc.slice(2)}`);
  assert.equal(extendedPath(`\\\\?\\${drive}`, 'win32'), `\\\\?\\${drive}`, 'a prefixed path is left alone');
  assert.equal(extendedPath(`\\\\.\\${drive}`, 'win32'), `\\\\.\\${drive}`);
  assert.equal(extendedPath(unc.replaceAll('\\', '/'), 'win32'), `\\\\?\\UNC\\${unc.slice(2)}`, 'a UNC path with forward slashes');
  assert.equal(extendedPath(`//?/${drive}`, 'win32'), `//?/${drive}`);
});
test('slashes, dots and repeated separators are resolved, since the prefix switches Windows\' own clean-up off', () => {
  const messy = drive.replace(/\\/g, '/').replace('/Pictures', '/Pictures/./extra/../') + '';
  const fixed = extendedPath(messy, 'win32');
  assert.equal(fixed, `\\\\?\\${drive}`);
  assert.equal(extendedPath(drive.replace('\\Users', '\\\\Users'), 'win32'), `\\\\?\\${drive}`);
  assert.ok(!fixed.slice(4).includes('/') && !fixed.includes('\\.\\') && !fixed.includes('..'));
});
test('the limit is a folder\'s 248 characters: shorter paths, relative paths and other systems are unchanged', () => {
  const at = (length: number) => `C:\\${'a'.repeat(length - 3)}`;
  assert.equal(extendedPath(at(LONG_PATH - 1), 'win32'), at(LONG_PATH - 1));
  assert.equal(extendedPath(at(LONG_PATH), 'win32'), `\\\\?\\${at(LONG_PATH)}`);
  const relative = `${'a\\'.repeat(200)}x.png`;
  assert.equal(extendedPath(relative, 'win32'), relative);
  assert.equal(extendedPath('\\rooted\\' + 'a'.repeat(300), 'win32'), '\\rooted\\' + 'a'.repeat(300));
  for (const platform of ['linux', 'darwin'] as const) assert.equal(extendedPath(drive, platform), drive);
  assert.equal(extendedPath('C:\\short\\a.png', 'win32'), 'C:\\short\\a.png');
});
test('plainPath undoes the prefix', () => {
  assert.equal(plainPath(extendedPath(drive, 'win32')), drive);
  assert.equal(plainPath(extendedPath(unc, 'win32')), unc);
  assert.equal(plainPath('C:\\a.png'), 'C:\\a.png');
  assert.equal(plainPath('\\\\.\\pipe\\clop'), '\\\\.\\pipe\\clop');
});
test('a tool\'s arguments get the prefix on paths, and on the path an option carries, but not on other text', () => {
  const out = `${drive}.out`;
  assert.equal(extendedArgument(`-sOutputFile=${out}`, 'win32'), `-sOutputFile=\\\\?\\${out}`);
  assert.equal(extendedArgument(`--output=${unc}`, 'win32'), `--output=\\\\?\\UNC\\${unc.slice(2)}`);
  const filter = `scale=${'1920:'.repeat(60)}-2`;
  assert.ok(filter.length > LONG_PATH);
  assert.equal(extendedArgument(filter, 'win32'), filter);
  assert.equal(extendedArgument('-i', 'win32'), '-i');
  assert.deepEqual(toolArguments('ffmpeg', ['-y', '-i', drive, 'C:\\short\\out.mp4', out], 'win32'), ['-y', '-i', `\\\\?\\${drive}`, 'C:\\short\\out.mp4', `\\\\?\\${out}`]);
  assert.deepEqual(toolArguments('ffmpeg', ['-i', drive], 'linux'), ['-i', drive]);
  assert.deepEqual(toolArguments('exiftool', ['-all=', drive], 'win32'), ['-all=', drive], 'ExifTool keeps its arguments');
});

/** A folder 300 characters deep and a file in it, which only the extended form opens on Windows without a registry setting. */
async function longFolder(t: TestContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clop-long-')), short = path.join(base, 'short');
  let folder = path.join(base, 'long');
  while (folder.length < 300) folder = path.join(folder, 'folder'.repeat(5));
  await mkdir(short, { recursive: true }); await mkdir(folder, { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { short, folder };
}

// Windows is where this matters (the limit is Windows'); elsewhere it shows that nothing about a long path changes.
test('tools and sharp open files under paths over 260 characters', async t => {
  if (!needTools(t, 'ffmpeg', 'ffprobe', 'pngquant', 'jpegoptim', 'gs')) return;
  const { short, folder } = await longFolder(t);
  const video = path.join(folder, 'screen.mp4'), picture = path.join(folder, 'shot.png');
  assert.ok(video.length > 260);
  await clip(path.join(short, 'screen.mp4'));
  await copyFile(path.join(short, 'screen.mp4'), video);
  await graphic(120, 90).png({ compressionLevel: 0 }).toFile(path.join(short, 'shot.png'));
  await copyFile(path.join(short, 'shot.png'), picture);
  assert.equal((await probe(video)).kind, 'video');
  assert.equal((await probe(picture)).kind, 'image');
  const out = path.join(short, 'out');
  const optimised = await optimiseVideo(video, out, { compression: { tier: 'smaller', factor: 50 }, allowLarger: true });
  assert.ok((await stat(optimised.path)).size > 0);
  // Ghostscript is the other tool that gets the user's full path (`-sOutputFile=` stays in the scratch folder, the input does not).
  const pdf = path.join(folder, 'scan.pdf');
  await writeFile(pdf, await photoPDF({ pages: 1, dpi: 200 }));
  assert.ok((await optimisePDF(pdf, out, { aggressive: true, allowLarger: true })).bytes > 0);
  assert.equal((await optimiseImage(picture, out, { compression: { tier: 'custom', factor: 50 } })).format, 'png');
});
