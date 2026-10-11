import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { PDFDocument } from '@cantoo/pdf-lib';
import sharp from 'sharp';
import { graphic, photo } from '../core/media/image.fixtures';
import { run } from '../core/run';
import { needTools } from '../core/testing';
import { validateItems } from './items';
import { main } from './main';

/** A folder of files and an empty app data folder; `clop` runs headless in this process with captured output. */
async function cli(t: TestContext, colours = false, env: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const userData = path.join(dir, 'data');
  const io = { out: [] as string[], err: [] as string[] };
  const clop = async (...argv: string[]) => {
    io.out.length = 0; io.err.length = 0;
    return main(argv, { io: { out: text => { io.out.push(text); }, err: text => { io.err.push(text); }, errTTY: false }, cwd: dir, options: { userData, home: dir }, env, colours });
  };
  const settings = async () => JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8'));
  return { dir, userData, clop, settings, out: () => io.out.join(''), err: () => io.err.join(''), file: (name: string) => path.join(dir, name) };
}

test('optimise works headless: results as JSON, exit 0 unless every file failed, 64 for a usage error', async t => {
  if (!needTools(t, 'pngquant', 'jpegoptim')) return;
  const c = await cli(t);
  await graphic(400, 300).png({ compressionLevel: 0 }).toFile(c.file('a.png'));
  await photo(400, 300).jpeg({ quality: 100 }).toFile(c.file('b.jpg'));
  await writeFile(c.file('broken.png'), 'not an image');
  assert.equal(await c.clop('optimise', 'a.png', 'b.jpg', 'broken.png', '-j', '-n'), 0, c.err());
  const result = JSON.parse(c.out());
  assert.deepEqual(result.done.map((r: { path: string }) => path.basename(r.path)), ['a.png', 'b.jpg']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].forURL.endsWith('broken.png'), true);
  assert.equal(await c.clop('optimise', 'broken.png'), 1, 'every file failed');
  assert.match(c.out(), /✘ .*broken\.png: /);
  assert.equal(await c.clop('optimise', 'nope.png'), 64);
  assert.match(c.err(), /^Error: File .*nope\.png does not exist\nUsage: clop optimise files/);
  assert.equal(await c.clop('optimise', 'nope.png', '--skip-errors', '--json'), 0);
  assert.deepEqual(JSON.parse(c.out()), { done: [], failed: [] });
});

test('a file named twice, or named and inside a named folder, is sent once', async t => {
  const c = await cli(t);
  await graphic(20, 20).png().toFile(c.file('a.png'));
  const urls = await validateItems(['a.png', 'a.png', '.'], { recursive: false, skipErrors: false, types: ['png'], cwd: c.dir });
  assert.equal(urls.length, 1);
});

test('crop with several files needs a folder for its output, as optimise does', async t => {
  const c = await cli(t);
  await graphic(20, 20).png().toFile(c.file('a.png'));
  await graphic(20, 20, { seed: 3 }).png().toFile(c.file('b.png'));
  await writeFile(c.file('result.png'), 'a file');
  assert.equal(await c.clop('crop', '-s', '10x10', '-o', 'result.png', 'a.png', 'b.png'), 64);
  assert.match(c.err(), /Output path must be a folder when processing multiple files/);
});

test('result lines are coloured as Colorize.swift colours them when stdout is a terminal', async t => {
  if (!needTools(t, 'pngquant')) return;
  const c = await cli(t, true);
  await graphic(400, 300).png({ compressionLevel: 0 }).toFile(c.file('a.png'));
  await graphic(200, 100, { seed: 5 }).png({ compressionLevel: 0 }).toFile(c.file('b.png'));
  assert.equal(await c.clop('optimise', '--no-progress', 'a.png', 'b.png'), 0, c.err());
  const [first, , total] = c.out().split('\n');
  assert.match(first, /^\x1b\[32m✓\x1b\[0m \x1b\[4m.*a\.png\x1b\[0m: \x1b\[38;5;9m[\d.]+[KM]B\x1b\[0m \x1b\[2m->\x1b\[0m \x1b\[1m\x1b\[38;5;2m[\d.]+KB\x1b\[0m\x1b\[1m\x1b\[0m\x1b\[2m \(\x1b\[38;5;2m[\d.]+%\x1b\[0m\x1b\[2m smaller\)\x1b\[0m$/);
  assert.match(total, /^\x1b\[32m✓\x1b\[0m \x1b\[4mTOTAL\x1b\[0m: /);
});

test('crop, downscale and convert validate their arguments as macOS does', async t => {
  const c = await cli(t);
  assert.equal(await c.clop('crop', '--long-edge', '--size', '100x50', 'a.png'), 64);
  assert.match(c.err(), /When using --long-edge, the size must be a single number/);
  assert.equal(await c.clop('crop', 'a.png'), 64);
  assert.match(c.err(), /Missing expected argument '--size <size>'/);
  assert.equal(await c.clop('downscale', '--factor', '1.5', 'a.png'), 64);
  assert.match(c.err(), /must be greater than 0 and less than 1/);
  assert.equal(await c.clop('convert', 'image', '--to', 'bmp', 'a.png'), 64);
  assert.match(c.err(), /Invalid --to format 'bmp': expected one of webp, avif, heic, jxl, jpeg, jpg, png/);
  assert.equal(await c.clop('optimise', 'video', '--encoder', 'gpu', 'a.mp4'), 64);
  assert.match(c.err(), /expected 'hardware', 'software', 'lossless' or 'adaptive'/);
  assert.equal(await c.clop('optimise', 'pdf', '--dpi', '96', 'a.pdf'), 64);
  assert.match(c.err(), /--dpi must be 'adaptive' or one of 300, 250, 200, 150, 100, 72, 48/);
  assert.equal(await c.clop('optimise', '--frobnicate'), 64);
  assert.match(c.err(), /Unknown option '--frobnicate'/);
  assert.equal(await c.clop('optimise', '--help'), 0);
  assert.match(c.out(), /SUBCOMMANDS:\n {2}image .*\n {2}video .*\n {2}pdf .*\n {2}audio /);
});

test('crop and convert image run through the same service and name their results', async t => {
  if (!needTools(t, 'pngquant')) return;
  const c = await cli(t);
  await photo(800, 600).png().toFile(c.file('photo.png'));
  assert.equal(await c.clop('crop', '-s', '16:9', '-o', 'out/', 'photo.png', '-j'), 0, c.err());
  const cropped = JSON.parse(c.out()).done[0];
  assert.equal(cropped.path, c.file(path.join('out', 'photo.png')));
  assert.deepEqual(cropped.newWidthHeight, [800, 450]);
  assert.equal(await c.clop('convert', 'image', '--to', 'webp', 'photo.png', '-j'), 0, c.err());
  assert.equal(JSON.parse(c.out()).done[0].path, c.file('photo.webp'));
  assert.equal(await c.clop('downscale', '--factor', '0.25', '-o', '%f-%s', 'photo.png', '-j'), 0, c.err());
  assert.deepEqual(JSON.parse(c.out()).done[0].newWidthHeight, [200, 150]);
  assert.ok(await stat(c.file('photo-0.25.png')));
});

test('settings schema, get and set read and write the settings file when the app is not running', async t => {
  const c = await cli(t);
  assert.equal(await c.clop('settings', 'set', 'videoCompression', 'smaller:70'), 0, c.err());
  assert.match(c.out(), /videoCompression = smaller:70 {3}one of: adaptive, lossless, fast, smaller, custom, <tier>:<0-100>, <0-100>/);
  assert.deepEqual((await c.settings()).videoCompression, { tier: 'smaller', factor: 70 });
  assert.equal(await c.clop('settings', 'strip', 'metadata'), 0);
  assert.match(c.out(), /^stripMetadata\n {2}Strip identifying EXIF metadata\.\n {2}stripMetadata = true/);
  assert.equal(await c.clop('settings', 'get', 'nope', '--json'), 1);
  assert.equal(JSON.parse(c.out()).ok, false);
});

test('the pipeline library: add, show, list, attach, detach, presets and delete', async t => {
  const c = await cli(t);
  assert.equal(await c.clop('pipeline', 'add', '--file-type', 'image', 'Web ready', 'convert(to: webp)'), 0, c.err());
  assert.equal(c.out(), '✓ Saved pipeline Web ready: convert(to: webp)\n');
  assert.equal(await c.clop('pipeline', 'add', 'web READY', 'optimise'), 64);
  assert.match(c.err(), /already exists, use `--force` to replace it/);
  assert.equal(await c.clop('pipeline', 'add', 'Bad', 'resize(to: 3)'), 64);
  assert.match(c.err(), /Unknown steps: resize/);
  assert.equal(await c.clop('pipeline', 'show', 'web ready'), 0);
  assert.equal(c.out(), 'convert(to: webp)\n');
  const downloads = c.file('Downloads');
  assert.equal(await c.clop('pipeline', 'attach', 'Web ready', '--source', downloads, '--type', 'image'), 0, c.err());
  assert.equal(c.out(), '✓ Attached to ~/Downloads (image): Web ready (now watching this folder)\n');
  assert.equal(await c.clop('pipeline', 'attach', 'downscale(factor: 0.5)', '--source', 'clipboard', '--type', 'video', '--skip-optimisation'), 0, c.err());
  const stored = await c.settings();
  assert.deepEqual(stored.imageDirs, ['~/Desktop', '~/Downloads']);
  assert.equal(stored.pipelinesToRunOnImage['~/Downloads'][0].libraryID, stored.savedPipelines[0].id);
  assert.deepEqual(stored.pipelinesToRunOnVideo.clipboard[0].steps, [{ downscale: { factor: 0.5, location: 'inPlace' } }]);
  assert.equal(stored.pipelinesToRunOnVideo.clipboard[0].skipOptimisation, true);
  assert.equal(await c.clop('pipeline', 'list'), 0);
  assert.equal(c.out(), 'Saved pipelines:\n  Web ready (image)\n    convert(to: webp)\n\nAutomations for images:\n  ~/Downloads -> Web ready reference\n    convert(to: webp)\n\nAutomations for videos:\n  clipboard [Skip optimisation]\n    downscale(factor: 0.5)\n');
  assert.equal(await c.clop('pipeline', 'list', '--json'), 0);
  assert.deepEqual(Object.keys(JSON.parse(c.out()).automations), ['images', 'videos']);
  assert.equal(await c.clop('pipeline', 'detach', '--source', downloads, '--type', 'image', '--all'), 0, c.err());
  assert.equal(c.out(), '✓ Removed 1 pipeline from ~/Downloads (image)\n  Stopped watching this folder for image\n');
  assert.deepEqual((await c.settings()).imageDirs, ['~/Desktop']);
  assert.equal(await c.clop('pipeline', 'detach', '--source', 'clipboard', '--type', 'video'), 64);
  assert.match(c.err(), /Pass either --index <n> or --all/);
  assert.equal(await c.clop('pipeline', 'preset', 'add', 'Web', 'Web ready', '--type', 'image'), 0, c.err());
  assert.equal(c.out(), '✓ Added preset zone Web (type: image)\n');
  assert.equal((await c.settings()).presetZones[0].id, 'Web-image');
  assert.equal(await c.clop('pipeline', 'preset', 'remove', 'Web', '--type', 'image'), 0, c.err());
  assert.deepEqual((await c.settings()).presetZones, []);
  assert.equal(await c.clop('pipeline', 'delete', 'Web Ready'), 0, c.err());
  assert.deepEqual((await c.settings()).savedPipelines, []);
});

test('pipeline prompt prints the DSL reference with the task appended', async t => {
  const c = await cli(t);
  assert.equal(await c.clop('pipeline', 'prompt', '--compact', 'shrink', 'screenshots'), 0);
  assert.match(c.out(), /^# Clop pipeline DSL \(compact\)/);
  assert.match(c.out(), /## Task\n\nshrink screenshots\n\nReturn ONE line/);
});

test('crop-pdf lists devices, crops to a paper size, and uncrop-pdf restores the page', async t => {
  const c = await cli(t);
  assert.equal(await c.clop('crop-pdf', '--list-devices'), 0);
  assert.match(c.out(), /^Devices, grouped by screen aspect ratio\.[\s\S]*iPhone:\n/);
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  await writeFile(c.file('letter.pdf'), await doc.save());
  assert.equal(await c.clop('crop-pdf', '--paper-size', 'A4', 'letter.pdf', '-o', 'a4.pdf'), 0, c.err());
  assert.equal(c.out(), `Cropping ${c.file('letter.pdf')} to aspect ratio 0.707 -> saved to ${c.file('a4.pdf')}\n`);
  const box = (await PDFDocument.load(await readFile(c.file('a4.pdf')))).getPage(0).getCropBox();
  assert.ok(Math.abs(box.width / box.height - 210 / 297) < 0.01);
  assert.equal(await c.clop('uncrop-pdf', 'a4.pdf'), 0, c.err());
  assert.deepEqual((await PDFDocument.load(await readFile(c.file('a4.pdf')))).getPage(0).getCropBox(), { x: 0, y: 0, width: 612, height: 792 });
  assert.equal(await c.clop('crop-pdf', '--paper-size', 'B99', 'letter.pdf'), 64);
  assert.match(c.err(), /Unknown paper size "B99", use --list-paper-sizes/);
});

test('strip-exif removes GPS but keeps the orientation', async t => {
  if (!needTools(t, 'exiftool')) return;
  const c = await cli(t);
  const file = c.file('gps.jpg');
  await photo(64, 48).jpeg().toFile(file);
  await run('exiftool', ['-overwrite_original', '-GPSLatitude=51.5', '-GPSLatitudeRef=N', '-Orientation#=6', '-Artist=Someone', file]);
  assert.equal(await c.clop('strip-exif', 'gps.jpg'), 0, c.err());
  assert.match(c.out(), /✓ .*gps\.jpg done/);
  const tags = JSON.parse((await run('exiftool', ['-j', '-n', '-GPSLatitude', '-Artist', '-Orientation', file])).stdout.toString())[0];
  assert.deepEqual([tags.GPSLatitude, tags.Artist, tags.Orientation], [undefined, undefined, 6]);
  assert.equal(await c.clop('strip-exif', 'missing.jpg'), 1);
});

test('the legacy convert writes next to the original and refuses to overwrite without --force', async t => {
  const c = await cli(t);
  await graphic(120, 80).png().toFile(c.file('icon.png'));
  assert.equal(await c.clop('convert', '-f', 'webp', '-q', '70', 'icon.png'), 0, c.err());
  assert.equal((await sharp(c.file('icon.webp')).metadata()).format, 'webp');
  assert.equal(await c.clop('convert', '-f', 'webp', 'icon.png'), 1);
  assert.match(c.err(), /icon\.webp already exists, use `--force` to replace/);
  assert.equal(await c.clop('convert', '-f', 'webp', '--force', '-o', 'out/%f-q%q', 'icon.png'), 0, c.err());
  assert.deepEqual(await readdir(c.file('out')), ['icon-q60.webp']);
});

test('the legacy convert from an agent is refused unless the user allowed agents', async t => {
  const c = await cli(t, false, { CLOP_ORIGIN: 'mcp' });
  await graphic(120, 80).png().toFile(c.file('icon.png'));
  assert.equal(await c.clop('convert', '-f', 'webp', 'icon.png'), 64, c.err());
  assert.match(c.err(), /not accepting changes from agents/);
  assert.equal(await stat(c.file('icon.webp')).then(() => true, () => false), false);
});

test('an agent is refused before any path it names is looked up', async t => {
  const c = await cli(t, false, { CLOP_ORIGIN: 'mcp' });
  for (const argv of [['optimise', 'nope.png'], ['downscale', '--factor', '0.5', 'nope.png'], ['strip-exif', 'nope.png'], ['crop-pdf', '--paper-size', 'A4', 'nope.pdf']]) {
    assert.equal(await c.clop(...argv), 64, argv.join(' '));
    assert.match(c.err(), /not accepting changes from agents/, argv.join(' '));
    assert.doesNotMatch(c.err(), /does not exist/, argv.join(' '));
  }
});

test('mcp status and logs persist read and write the switches', async t => {
  const c = await cli(t);
  assert.equal(await c.clop('mcp'), 0);
  assert.equal(c.out(), 'MCP changes:     not allowed\nScript steps:    not allowed\n\nAsk the user to allow it in Clop Settings, MCP, or run: start clop://mcp/start\n');
  assert.equal(await c.clop('mcp', 'status', '--json'), 0);
  assert.deepEqual(JSON.parse(c.out()), { ok: true, mcp: { allowScriptSteps: false, cardPath: path.join(c.userData, 'mcp.json'), enabled: false, requiresPro: false } });
  assert.equal(await c.clop('logs', 'persist', 'on'), 0, c.err());
  assert.equal((await c.settings()).persistDebugLogs, true);
  assert.equal(await c.clop('logs', 'persist', 'status'), 0);
  assert.equal(c.out(), `Debug logs for Clop are kept in ${path.join(c.userData, 'logs', 'clop.log')}\n`);
  assert.equal(await c.clop('logs', 'persist', 'maybe'), 64);
});

test('the bundled entry point runs as its own process', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-cli-process-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tsx = path.join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const { stdout } = await promisify(execFile)(process.execPath, [tsx, path.join(import.meta.dirname, 'index.ts'), 'settings', 'get', 'stripMetadata', '--json'], { env: { ...process.env, CLOP_USER_DATA: dir } });
  assert.equal(JSON.parse(stdout).settings[0].value, 'true');
  const failed = await promisify(execFile)(process.execPath, [tsx, path.join(import.meta.dirname, 'index.ts'), 'crop'], { env: { ...process.env, CLOP_USER_DATA: dir } }).catch(error => error);
  assert.equal(failed.code, 64);

  // clop.exe starts the CLI with ELECTRON_RUN_AS_NODE; programs the CLI starts must not inherit it.
  const image = path.join(dir, 'a.png'), seen = path.join(dir, 'seen.txt');
  await graphic(20, 20).png().toFile(image);
  const windows = process.platform === 'win32', script = path.join(dir, windows ? 'env.ps1' : 'env.sh');
  await writeFile(script, windows ? `Set-Content -LiteralPath '${seen}' -Value "[$env:ELECTRON_RUN_AS_NODE]"` : `printf '[%s]' "$ELECTRON_RUN_AS_NODE" > '${seen}'`);
  await promisify(execFile)(process.execPath, [tsx, path.join(import.meta.dirname, 'index.ts'), 'pipeline', 'run', `runScript(path: "${script.replaceAll('\\', '/')}")`, image, '-n'], { env: { ...process.env, CLOP_USER_DATA: dir, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal((await readFile(seen, 'utf8')).trim(), '[]');
});
