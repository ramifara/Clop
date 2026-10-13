import { spawn, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, writeFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from '@cantoo/pdf-lib';
import { WindowsBridge } from '../dist-electron/native-test.js';
import { dragFixture, dragStartedOrSkip, explorerFixture } from './drag-fixture.mjs';
import { unpackedDir } from './unpacked.mjs';
// The inspection below opens files in the temporary profile. Release their Windows handles
// immediately so the final recursive cleanup can remove that profile after the app exits.
sharp.cache(false);

// Exercise the actual packaged app and sandboxed preload through local Chrome DevTools.
const profile = await mkdtemp(path.join(os.tmpdir(), 'clop-desktop-'));
const executable = path.join(unpackedDir(), 'Clop for Windows.exe');
execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()']);
// Software H.264, so the video size check does not depend on which hardware encoder the runner happens to have.
// Images and videos are watched in a folder of the test profile, never the runner's real Desktop.
const watched = path.join(profile, 'Watched');
await mkdir(watched);
// A clipboard pipeline that converts images named "to-webp" to WebP, the built-in "to WebP" behind a filter, so every other
// copied image still takes the plain optimisation the checks below expect.
const clipboardPipeline = { id: 'SMOKE-TO-WEBP', name: 'to WebP', steps: [], rawText: 'if(nameContains: "to-webp") -> convert(to: webp)', skipOptimisation: true, hideResult: false };
// A preset zone for images running the built-in "to WebP" from the library (a reference, as the editor saves one), which the app seeds at startup.
const webpZone = { id: 'SMOKE-WEBP-ZONE', name: 'Smoke to WebP', icon: 'photo', type: 'image', pipeline: { id: 'SMOKE-WEBP-REF', steps: [], skipOptimisation: false, hideResult: false, libraryID: 'builtin-image-webp' } };
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ checkForUpdates: false, videoEncoder: 'libx264', imageDirs: [watched], videoDirs: [watched], pipelinesToRunOnImage: { clipboard: [clipboardPipeline] }, presetZones: [webpZone] }));
const app = spawn(executable, ['--remote-debugging-port=9227', `--user-data-dir=${profile}`], { stdio: 'pipe' });
let output = '';
app.stdout.on('data', chunk => { output += chunk; }); app.stderr.on('data', chunk => { output += chunk; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Waits for `task` to return something. On a timeout the error says what `explain` reports (the app's state), if given, to make the failure diagnosable. */
async function until(task, description, timeout = 30000, explain) {
  let last;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const value = await task(); if (value) return value; } catch (error) { last = error; } await pause(250); }
  const state = explain ? `\nApp state: ${await explain().catch(error => `could not be read (${error.message})`)}` : '';
  throw new Error(`${description}: ${last?.message ?? output.slice(-2000)}${state}`);
}
/** The app's items (status, error, kind, source, name) and notice, for a failure message. */
const appState = async window => { const state = await window.evaluate('window.clop.state()'); return JSON.stringify({ notice: state.notice, items: state.items.map(({ id, kind, source, status, error, name, progress }) => ({ id, kind, source, status, error, name, progress })) }); };
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', event => { const reply = JSON.parse(event.data); if (reply.id) { const request = pending.get(reply.id); if (request) { pending.delete(reply.id); clearTimeout(request.timer); reply.error ? request.reject(new Error(reply.error.message)) : request.resolve(reply.result); } } });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  return { close: () => ws.close(), send, evaluate: async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  } };
}
async function click(client, selector) {
  const point = await client.evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:rect.x + rect.width/2,y:rect.y + rect.height/2}; })()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
let main, floating, fixture;
/** Whether a result for `name` shows: as a card, or as a row once more results show than fit and the compact list takes over. */
const shown = name => floating.evaluate(`[...document.querySelectorAll('.corner-card, .compact-row')].some(row => { const label = row.getAttribute('aria-label') ?? ''; return label === ${JSON.stringify(`Optimised ${name}`)} || (row.classList.contains('compact-row') && label.endsWith(${JSON.stringify(` ${name}`)})); })`);
const externalClipboard = new WindowsBridge();
try {
  const pages = () => fetch('http://127.0.0.1:9227/json/list').then(response => response.json());
  const target = await until(async () => (await pages()).find(page => page.type === 'page' && page.url.includes('index.html') && !page.url.includes('floating')), 'Main window did not open');
  main = await connect(target);
  await until(() => main.evaluate('Boolean(window.clop && document.querySelector(".settings-window"))'), 'Sandboxed preload did not load');
  const initial = await main.evaluate('window.clop.state()'); assert.equal(initial.native, true); assert.equal(initial.platform, 'win32');
  assert.equal(initial.items.length, 0, 'The app should start quietly, with no sample or workbench');
  // A first run shows the welcome card until it is dismissed, and dismissing it is remembered.
  assert.equal(initial.welcome, true, 'A first run shows the welcome card');
  // The window that holds it is on screen, not waiting for some later event to show it.
  const welcomeWindow = await connect(await until(async () => (await pages()).find(page => page.type === 'page' && page.url.includes('floating')), 'Floating window did not open for the welcome card'));
  await until(() => welcomeWindow.evaluate("document.visibilityState === 'visible' && Boolean(document.querySelector('.welcome-card'))"), 'The welcome card is not showing on a first run');
  welcomeWindow.close();
  await main.evaluate("window.clop.window('finish-welcome')");
  const welcomed = await main.evaluate('window.clop.state()');
  assert.equal(welcomed.welcome, undefined, 'The welcome card is gone once dismissed');
  assert.equal(welcomed.settings.finishedOnboarding, true);
  const ready = once(externalClipboard, 'ready');
  externalClipboard.start(path.resolve('native/bridge.ps1')); await ready;
  await externalClipboard.request({ type: 'settings', explorerDrag: false });
  const sourceFile = path.join(profile, 'screenshot-über-画像.png');
  await sharp('../Clop/Assets.xcassets/preview-image-thumb.imageset/pv-image-thumb.jpg').resize(2400, 1600, { fit: 'cover' }).png({ compressionLevel: 0 }).toFile(sourceFile);
  // An external clipboard write must trigger processing and the corner card without opening Clop.
  await externalClipboard.request({ type: 'copy', file: sourceFile, png: sourceFile });
  const initialImage = await until(async () => (await main.evaluate('window.clop.state()')).items.find(item => item.status === 'ready' && item.source === 'clipboard'), 'Clipboard image did not automatically produce a result');
  assert.equal(initialImage.status, 'ready'); assert.equal(initialImage.width, 2400);
  await until(async () => { await main.evaluate(`window.clop.copy(${JSON.stringify(initialImage.id)})`); return true; }, 'Native clipboard did not connect');
  const floatTarget = await until(async () => (await pages()).find(page => page.type === 'page' && page.url.includes('floating')), 'Floating window did not open');
  floating = await connect(floatTarget);
  await until(() => floating.evaluate('Boolean(document.querySelector(".corner-card"))'), 'Automatic corner card did not render');
  await click(floating, '[aria-label="Convert to WEBP"]');
  await until(async () => (await main.evaluate('window.clop.state()')).items.some(item => item.id === initialImage.id && item.status === 'ready' && item.format === 'webp'), 'In-card format selection did not convert the image');
  await floating.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await click(floating, '[aria-label="Downscale"]');
  await until(() => floating.evaluate('Boolean(document.querySelector(".scale-presets"))'), 'In-card downscale controls did not open');
  await click(floating, '.scale-presets button:nth-child(3)');
  await until(async () => (await main.evaluate('window.clop.state()')).items.some(item => item.id === initialImage.id && item.status === 'ready' && item.width === 1200), 'In-card 50% preset did not downscale the image');
  await floating.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  const afterApply = await main.evaluate('window.clop.state()');
  console.log('After applying WebP and 50%:', JSON.stringify({ notice: afterApply.notice, items: afterApply.items.map(({id,status,error,width,height,format,source,options}) => ({id,status,error,width,height,format,source,options})) }));
  const resized = afterApply.items.find(item => item.id === initialImage.id);
  assert.equal(resized?.status, 'ready', resized?.error);
  assert.deepEqual([resized.width, resized.height, resized.format], [1200, 800, 'webp']);
  assert.ok(resized.outputBytes < initialImage.originalBytes);
  await until(() => floating.evaluate('Boolean(document.querySelector(".corner-card") && document.body.innerText.includes("1200×800"))'), 'Automatic corner card did not render');
  const layout = await floating.evaluate('(() => { const rect = document.querySelector(".corner-card").getBoundingClientRect(); return {width:rect.width,height:rect.height,bottom:rect.bottom,viewport:innerHeight,selected:document.querySelector(".format-bar button.active").innerText}; })()');
  assert.deepEqual([layout.width, layout.height, layout.selected], [196, 166, 'WEBP']);
  assert.ok(layout.bottom <= layout.viewport, 'Corner card should fit its transparent window');
  assert.equal(await floating.evaluate('Boolean(document.querySelector(".sidebar,.dropzone,.image-editor"))'), false, 'No workbench should exist');
  await pause(1000);
  assert.equal((await main.evaluate('window.clop.state()')).items.length, 1, 'Own clipboard writes must not create a loop');
  assert.equal(await floating.evaluate('document.querySelector(".corner-notice")?.textContent ?? ""'), '', 'Fast in-card format and resize actions must not show a clipboard error');
  console.log('Inspecting the native clipboard output after format and downscale.');
  await until(async () => {
    const snapshot = await externalClipboard.request({ type: 'read' });
    console.log('Clipboard files:', JSON.stringify(snapshot.paths));
    if (!snapshot.paths?.[0]) return false;
    const metadata = await sharp(snapshot.paths[0]).metadata();
    console.log('Clipboard image:', metadata.width, metadata.height, metadata.format);
    return metadata.width === 1200 && metadata.height === 800 && metadata.format === 'webp';
  }, 'Automatic clipboard output did not match the card’s selected format and downscale');
  await mkdir('release', { recursive: true });
  for (const [name, client] of [['floating', floating]]) {
    const capture = await client.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`release/Windows-${name}.png`, Buffer.from(capture.data, 'base64'));
  }
  await main.evaluate(`window.clop.restore(${JSON.stringify(initialImage.id)})`);
  const restored = (await main.evaluate('window.clop.state()')).items.find(item => item.id === initialImage.id); assert.equal(restored.restored, true); assert.equal(restored.outputBytes, initialImage.originalBytes);
  fixture = await dragFixture(sourceFile);
  // Observe every state update, including transient popups, while an image remains on the clipboard.
  await main.evaluate('window.clop.subscribe(state => { if (state.dropActive) window.unexpectedDragTarget = true; })');
  for (const kind of ['text', 'textDrag', 'blank', 'unsupported', 'title', 'resize']) {
    await main.evaluate('window.unexpectedDragTarget = false');
    await fixture.gesture(kind); await pause(300);
    assert.equal(await main.evaluate('Boolean(window.unexpectedDragTarget)'), false, `${kind} must not reveal a target in the packaged app`);
    assert.equal(await floating.evaluate('Boolean(document.querySelector(".drop-target"))'), false, `${kind} must not leave a target behind`);
  }
  // The app's own native helper must still reveal the target for a real image OLE drag.
  // First the test window must really start the drag; if it cannot (ARM64 only), the steps that need a drag are skipped (see dragStartedOrSkip).
  const dragsBefore = fixture.sourceDrags;
  const dragFinished = fixture.gesture('image', { hold: 2500 });
  let dragging = dragStartedOrSkip(await fixture.dragsSince(dragsBefore, 8000), 'the image gesture');
  if (dragging) {
    await until(() => floating.evaluate('Boolean(document.querySelector(".drop-target"))'), 'Dragging did not reveal the automatic corner target');
    const dragCapture = await floating.send('Page.captureScreenshot', { format: 'png' });
    await writeFile('release/Windows-drag-target.png', Buffer.from(dragCapture.data, 'base64'));
  }
  await dragFinished;
  if (dragging) {
    await until(() => floating.evaluate('!document.querySelector(".drop-target")'), 'Releasing the drag did not dismiss its target');
    assert.ok((await main.evaluate('window.clop.state()')).items.every(item => item.id === initialImage.id), 'Dragging without a drop must not import another image');
  }
  // A browser/screenshot image has no file-drop payload. Copy text between repeated copies
  // of the image so content deduplication does not permanently suppress that image.
  execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText("Clop clipboard smoke")']);
  await pause(1000);
  execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = New-Object System.Drawing.Bitmap($env:CLOP_SMOKE_IMAGE); $stream = New-Object System.IO.MemoryStream(,[System.IO.File]::ReadAllBytes($env:CLOP_SMOKE_IMAGE)); try { $data = New-Object System.Windows.Forms.DataObject; $data.SetImage($image); $data.SetData("PNG",$false,$stream); [System.Windows.Forms.Clipboard]::SetDataObject($data,$true,5,100) } finally { $stream.Dispose(); $image.Dispose() }'], { env: { ...process.env, CLOP_SMOKE_IMAGE: sourceFile } });
  const pixelImage = await until(async () => (await main.evaluate('window.clop.state()')).items.find(item => item.id !== initialImage.id && item.status === 'ready' && item.source === 'clipboard'), 'A pixel-only clipboard image did not automatically produce a new card');
  assert.deepEqual([pixelImage.originalWidth, pixelImage.originalHeight], [2400, 1600]);
  await pause(1000);
  const finalState = await main.evaluate('window.clop.state()');
  // The older result may have reached its normal ten-second dismissal by now.
  assert.equal(finalState.items.filter(item => item.id !== initialImage.id).length, 1, 'Pixel-only clipboard writes must produce exactly one new card');
  assert.equal(finalState.notice, undefined, 'Pixel-only clipboard processing must not show an error');
  // Copies by an ignored app are left alone: here Windows PowerShell is the fixture app that copies. A new image, so only the ignore keeps it from a card.
  // One PowerShell by its full path for the sleeper and every copy: ARM64 Windows has more than one powershell.exe (System32's native one, SysWOW64's x86 one),
  // and the ignored entry must name the one that copies.
  const powershellExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const samePath = (a, b) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
  const ignoredImage = path.join(profile, 'ignored.png');
  await sharp(sourceFile).resize(1200, 800).png().toFile(ignoredImage);
  // Each copy keeps its PowerShell open a moment, as an app that copies does: the clipboard's owner is a window of the process that copied, and
  // once that process exits Windows no longer says who copied, so Clop would take the app in front for it.
  const stay = 'Start-Sleep -Milliseconds 1500';
  const copyImage = () => execFileSync(powershellExe, ['-NoProfile', '-Sta', '-Command', `$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = New-Object System.Drawing.Bitmap($env:CLOP_SMOKE_IMAGE); try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }; ${stay}`], { env: { ...process.env, CLOP_SMOKE_IMAGE: ignoredImage } });
  const known = new Set(finalState.items.map(item => item.id)), fresh = async () => (await main.evaluate('window.clop.state()')).items.find(item => !known.has(item.id) && item.source === 'clipboard');
  // Copying text first ends the clipboard pickup's editing session with the earlier image, which would otherwise hold back every further image copied from the app in front until the user leaves it.
  const copyText = () => execFileSync(powershellExe, ['-NoProfile', '-Sta', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText("Clop ignored apps smoke"); ${stay}`]);
  // Who copied, as the smoke's own helper heard it for each clipboard change: what Clop's helper reports the same way.
  const copiers = [], heard = event => copiers.push({ sequence: event.sequence, owner: event.owner, aumid: event.aumid, foreground: event.app, image: event.image });
  externalClipboard.on('clipboard', heard);
  // Ignored apps come from the helper's list of programs, as in the settings window, so a PowerShell is kept running to be listed.
  const sleeper = spawn(powershellExe, ['-NoProfile', '-Command', 'Start-Sleep -Seconds 120'], { stdio: 'ignore' });
  let powershell, listed = [];
  try {
    powershell = await until(async () => {
      listed = (await main.evaluate('window.clop.apps()')).filter(app => /\\powershell\.exe$/i.test(app.path));
      return listed.find(app => samePath(app.path, powershellExe))?.path;
    }, `${powershellExe} is not in the list of apps to ignore`, 30000, async () => JSON.stringify(listed));
  } finally { sleeper.kill(); }
  console.log(`Ignoring ${powershell}; PowerShells listed: ${JSON.stringify(listed.map(app => app.path))}`);
  await main.evaluate(`window.clop.prefs({ action: 'ignore', op: 'add', entry: ${JSON.stringify(powershell)} })`);
  assert.deepEqual((await main.evaluate('window.clop.state()')).settings.clipboardIgnoredAppBundleIds, [powershell]);
  copyText(); await pause(1000);
  copiers.length = 0;
  copyImage(); await pause(3000);
  const optimised = await fresh();
  assert.equal(optimised, undefined, `An image copied by an ignored app must not be optimised. Ignored: ${powershell}; the copy as the helper heard it: ${JSON.stringify(copiers)}; the result: ${JSON.stringify(optimised && { name: optimised.name, status: optimised.status })}`);
  externalClipboard.off('clipboard', heard);
  await main.evaluate(`window.clop.prefs({ action: 'ignore', op: 'remove', entry: ${JSON.stringify(powershell)} })`);
  copyText(); await pause(1000);
  copyImage();
  await until(fresh, 'The same copy was not optimised once its app was no longer ignored');
  // Videos, PDFs and audio copied as files, as Explorer copies them (a file list and nothing else), each get a card once
  // their clipboard setting is on, and the clipboard then holds the optimised file under the same name.
  await main.evaluate('window.clop.settings({ optimiseVideoClipboard: true, optimisePDFClipboard: true, optimiseAudioClipboard: true })');
  const ffmpeg = path.join(unpackedDir(), 'resources', 'bin', 'ffmpeg.exe');
  const video = path.join(profile, 'clip-über.mp4'), song = path.join(profile, 'song.mp3'), scan = path.join(profile, 'scan.pdf');
  // Near-lossless H.264 and 320 kbps MP3 leave the optimisers something to save.
  execFileSync(ffmpeg, ['-y', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  execFileSync(ffmpeg, ['-y', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3', '-f', 'lavfi', '-i', 'anoisesrc=duration=3:amplitude=0.05:sample_rate=44100:seed=1', '-filter_complex', '[0][1]amix=inputs=2,aformat=channel_layouts=stereo[a]', '-map', '[a]', '-c:a', 'libmp3lame', '-b:a', '320k', song]);
  // Four pages showing one photo-like JPEG at 285 DPI, which Ghostscript downsamples.
  const pixels = Buffer.alloc(1140 * 855 * 3);
  for (let y = 0, i = 0; y < 855; y++) for (let x = 0; x < 1140; x++) { const grain = ((x * 7919 + y * 104729) % 23) - 11; pixels[i++] = 128 + 90 * Math.sin(x / 37 + y / 53) + grain; pixels[i++] = 128 + 80 * Math.sin(x / 23 - y / 41 + 1) + grain; pixels[i++] = 128 + 70 * Math.cos((x + y) / 61) + grain; }
  const pdf = await PDFDocument.create(), photo = await pdf.embedJpg(await sharp(pixels, { raw: { width: 1140, height: 855, channels: 3 } }).jpeg({ quality: 95 }).toBuffer());
  for (let page = 0; page < 4; page++) pdf.addPage([288, 216]).drawImage(photo, { x: 0, y: 0, width: 288, height: 216 });
  await writeFile(scan, await pdf.save());
  const copyFiles = files => execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.Windows.Forms; $list = New-Object System.Collections.Specialized.StringCollection; foreach ($file in $env:CLOP_SMOKE_FILES.Split([char]10)) { [void]$list.Add($file) }; [System.Windows.Forms.Clipboard]::SetFileDropList($list)'], { env: { ...process.env, CLOP_SMOKE_FILES: files.join('\n') } });
  // As on macOS, a copied video, PDF or audio file is optimised where it is (`optimised…Behaviour`, in place by default), its original kept in
  // the working directory's backups, and the clipboard keeps naming it. Copies of the fixtures are used, so the files the later steps copy stay as they were.
  const copiedDir = path.join(profile, 'Copied');
  await mkdir(copiedDir);
  for (const [source, kind] of [[video, 'video'], [scan, 'pdf'], [song, 'audio']]) {
    const file = path.join(copiedDir, path.basename(source));
    await copyFile(source, file);
    const sourceBytes = (await stat(file)).size;
    const before = new Set((await main.evaluate('window.clop.state()')).items.map(item => item.id));
    copyFiles([file]);
    const item = await until(async () => (await main.evaluate('window.clop.state()')).items.find(item => !before.has(item.id) && item.kind === kind && item.source === 'clipboard' && item.status !== 'processing'), `Copying a ${kind} file did not produce a result`, 90000, () => appState(main));
    console.log(`Clipboard ${kind}:`, JSON.stringify({ status: item.status, error: item.error, format: item.format, originalBytes: item.originalBytes, outputBytes: item.outputBytes, durationMs: item.durationMs, pages: item.pages }));
    assert.equal(item.status, 'ready', item.error);
    assert.ok(item.outputBytes < item.originalBytes, `The ${kind} should be smaller after optimising`);
    await until(() => shown(path.basename(file)), `The ${kind} card did not render`);
    const rewritten = await until(async () => { const read = await externalClipboard.request({ type: 'read' }); const [result] = read.paths; return result && path.basename(result) === path.basename(file) && result; }, `The clipboard was not rewritten with the optimised ${kind}`);
    assert.equal(path.resolve(rewritten).toLowerCase(), path.resolve(file).toLowerCase(), `The clipboard should name the copied ${kind}, optimised where it is`);
    assert.equal((await stat(file)).size, item.outputBytes, `The copied ${kind} should be replaced by its optimised version`);
    const copiedBackup = (await readdir(path.join(profile, 'work', 'backups'))).find(name => name.startsWith(`${path.parse(file).name}-`) && name.endsWith(path.extname(file)));
    assert.ok(copiedBackup, `The copied ${kind}'s original should be in the backups`);
    assert.equal((await stat(path.join(profile, 'work', 'backups', copiedBackup))).size, sourceBytes, `The backup should be the original ${kind}`);
  }
  assert.equal((await main.evaluate('window.clop.state()')).notice, undefined, 'Copying video, PDF and audio files must not show an error');
  // A video and an image dropped into a watched folder are optimised where they are, each original kept in the working directory's backups.
  const dropped = [[video, path.join(watched, 'desk-clip.mp4'), 'video'], [sourceFile, path.join(watched, 'desk-shot.png'), 'image']];
  const before = new Set((await main.evaluate('window.clop.state()')).items.map(item => item.id));
  for (const [source, target] of dropped) await copyFile(source, target);
  for (const [source, target, kind] of dropped) {
    const name = path.basename(target);
    const item = await until(async () => (await main.evaluate('window.clop.state()')).items.find(item => !before.has(item.id) && item.source === 'folder' && item.name === name && item.status !== 'processing'), `The ${kind} dropped into the watched folder was not optimised`, 120000);
    console.log(`Watched ${kind}:`, JSON.stringify({ status: item.status, error: item.error, originalBytes: item.originalBytes, outputBytes: item.outputBytes }));
    assert.equal(item.status, 'ready', item.error);
    const originalBytes = (await stat(source)).size;
    assert.equal((await stat(target)).size, item.outputBytes, `The watched ${kind} should be replaced by its optimised version`);
    assert.ok(item.outputBytes < originalBytes, `The watched ${kind} should be smaller after optimising`);
    const backups = path.join(profile, 'work', 'backups'), backup = (await readdir(backups)).find(file => file.startsWith(`${path.parse(name).name}-`) && file.endsWith(path.extname(name)));
    assert.ok(backup, `The watched ${kind}'s original should be in the backups`);
    assert.equal((await stat(path.join(backups, backup))).size, originalBytes, `The backup should be the original ${kind}`);
    await until(() => shown(name), `The watched ${kind}'s card did not render`);
  }
  assert.equal((await main.evaluate('window.clop.state()')).notice, undefined, 'Watched-folder optimisation must not show an error');
  // The clipboard pipeline: a copied image named "to-webp" becomes a WebP card, and the clipboard then holds the WebP.
  const startup = await main.evaluate('window.clop.state()');
  assert.ok(startup.settings.savedPipelines.some(pipeline => pipeline.id === 'builtin-image-webp'), 'The built-in pipelines should be seeded at startup');
  const webpSource = path.join(profile, 'to-webp.png');
  await sharp(sourceFile).resize(800, 533).png().toFile(webpSource);
  const beforePipeline = new Set(startup.items.map(item => item.id));
  copyFiles([webpSource]);
  const converted = await until(async () => (await main.evaluate('window.clop.state()')).items.find(item => !beforePipeline.has(item.id) && item.source === 'clipboard' && item.kind === 'image' && item.status !== 'processing'), 'The clipboard pipeline did not produce a result', 60000);
  console.log('Clipboard pipeline:', JSON.stringify({ status: converted.status, error: converted.error, format: converted.format, notes: converted.notes }));
  assert.equal(converted.status, 'ready', converted.error);
  assert.equal(converted.format, 'webp', 'The attached pipeline should convert the copied image to WebP');
  const pipelineCopy = await until(async () => { const [result] = (await externalClipboard.request({ type: 'read' })).paths; return result?.endsWith('.webp') && result; }, 'The clipboard did not get the pipeline\'s WebP');
  assert.equal((await sharp(pipelineCopy).metadata()).format, 'webp');
  // Explorer's right-click verbs (spec step 39): Explorer starts the app once per selected file. Every launch reaches the running app,
  // which gathers them and optimises them in place, and no other process does the work. This proves the routing while the app is running (the warm
  // path); that a file named like an option stays a file comes from the `--` before the files, which the unit tests of `explorerVerb` pin. Nothing here
  // covers a verb launched while the app is not running yet (the cold start).
  const verbFiles = [];
  for (const name of ['first verb.png', 'second verb.png']) {
    const file = path.join(profile, name);
    await sharp({ create: { width: 900, height: 600, channels: 3, background: '#3a7bd5' } }).composite([{ input: Buffer.from('<svg width="900" height="600"><circle cx="450" cy="300" r="250" fill="#f5a623"/></svg>') }]).png({ compressionLevel: 0 }).toFile(file);
    verbFiles.push([file, (await stat(file)).size]);
  }
  for (const [file] of verbFiles) spawn(executable, [`--user-data-dir=${profile}`, '--clop-optimise', '--', file], { stdio: 'ignore' }).unref();
  for (const [file, before] of verbFiles) await until(async () => (await stat(file)).size < before, `The Explorer verb did not optimise ${path.basename(file)}`, 60000);
  assert.equal((await main.evaluate('window.clop.state()')).notice, undefined, 'An Explorer verb must not show an error');
  console.log('Explorer verb launches reached the running app and optimised both files.');
  // A folder with two images, dragged from a real Explorer window onto the drop zone, opens the batch window with both files: the
  // helper must offer a folder as a drag, the zone must take the drop, and the dropped folder must reach the batch. As on macOS only a
  // folder holding more files than `batchModeFileCountThreshold` goes there, so the threshold is lowered to 1 for this drop.
  // A real Explorer window starts that drag through the same synthetic mouse input as the test window, so it is skipped with it.
  if (!dragging) console.log('The folder drag from Explorer is skipped with the other real-drag steps on ARM64.');
  else {
    const photos = path.join(profile, 'Two photos');
    await mkdir(photos);
    const folderFiles = ['first.png', 'second.png'].map(name => path.join(photos, name));
    for (const file of folderFiles) await sharp({ create: { width: 640, height: 400, channels: 3, background: '#3a7bd5' } }).png({ compressionLevel: 0 }).toFile(file);
    await fixture?.stop();
    // No cards in the way, so the drop zone sits where it is measured. It is shown on purpose to measure it, then hidden: the drag has to bring it back.
    for (const item of (await main.evaluate('window.clop.state()')).items) await main.evaluate(`window.clop.dismiss(${JSON.stringify(item.id)})`);
    await main.evaluate('window.clop.settings({ keepDropZoneVisible: true })');
    await until(() => floating.evaluate('Boolean(document.querySelector(".drop-target"))'), 'The drop zone did not show to be measured');
    await pause(500);
    const zone = await floating.evaluate('(() => { const rect = document.querySelector(".drop-target").getBoundingClientRect(); return { x: (screenX + rect.x + rect.width / 2) * devicePixelRatio, y: (screenY + rect.y + rect.height / 2) * devicePixelRatio }; })()');
    await main.evaluate('window.clop.settings({ keepDropZoneVisible: false })');
    await until(() => floating.evaluate('!document.querySelector(".drop-target")'), 'The drop zone did not hide again');
    assert.equal((await main.evaluate('window.clop.state()')).settings.useBatchModeForFolders, true, 'Large folders go to the batch window by default');
    await main.evaluate('window.clop.settings({ batchModeFileCountThreshold: 1 })');
    fixture = await explorerFixture(await realpath(photos));
    const folderDrag = fixture.gesture('image', { pressDelay: 4000, hold: 2500, to: zone });
    await until(() => floating.evaluate('Boolean(document.querySelector(".drop-target"))'), 'Dragging a folder from Explorer did not reveal the drop zone', 30000);
    await folderDrag;
    const batchWindow = await connect(await until(async () => (await pages()).find(page => page.type === 'page' && page.url.includes('batch=1')), 'Dropping a folder did not open the batch window', 30000));
    try {
      const prepared = await until(async () => { const state = await batchWindow.evaluate('window.clopBatch.state()'); return state.files.length === 2 && state; }, 'The batch window does not hold both images of the dropped folder', 30000, () => batchWindow.evaluate('window.clopBatch.state().then(state => JSON.stringify(state.files.map(file => file.path)))'));
      assert.deepEqual(prepared.files.map(file => path.basename(file.path)).sort(), ['first.png', 'second.png']);
      assert.equal((await main.evaluate('window.clop.state()')).items.length, 0, 'A dropped folder goes to the batch window, not to floating results');
      await batchWindow.evaluate('window.clopBatch.clear()');
    } finally { batchWindow.close(); }
    await main.evaluate('window.clop.settings({ batchModeFileCountThreshold: 30 })');
    console.log('A folder dragged from Explorer onto the drop zone opened the batch window with both of its images.');
  }
  // Files are put in the page as a drop puts them: a hidden file input that DevTools fills with paths gives the page Files whose paths
  // `webUtils` reads, as the drop zone's and the preset zones' handlers do.
  const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  async function pick(files) {
    await main.evaluate('document.querySelector("input[type=file]")?.remove()');
    const input = await main.send('Runtime.evaluate', { expression: '(() => { const input = document.createElement("input"); input.type = "file"; input.multiple = true; input.style.display = "none"; document.body.append(input); return input; })()' });
    await main.send('DOM.setFileInputFiles', { objectId: input.result.objectId, files });
    assert.equal(await main.evaluate('document.querySelector("input[type=file]").files.length'), files.length, 'The file input should hold what is dropped');
    return '[...document.querySelector("input[type=file]").files]';
  }
  // A file dropped on the drop zone is placed as macOS places it, by `optimisedImageBehaviour` (in place by default): the file itself
  // is optimised, its original goes into the working directory's backups, and Restore on the card puts the original back.
  const dropFolder = path.join(profile, 'Drop photos');
  await mkdir(dropFolder);
  const dropFile = path.join(dropFolder, 'dropped.png');
  await sharp({ create: { width: 900, height: 600, channels: 3, background: '#3ad57b' } }).composite([{ input: Buffer.from('<svg width="900" height="600"><rect x="100" y="80" width="500" height="300" fill="#202a44"/><circle cx="600" cy="360" r="180" fill="#f5a623"/></svg>') }]).png({ compressionLevel: 0 }).toFile(dropFile);
  const dropOriginal = await digest(dropFile), dropOriginalBytes = (await stat(dropFile)).size;
  for (const item of (await main.evaluate('window.clop.state()')).items) await main.evaluate(`window.clop.dismiss(${JSON.stringify(item.id)})`);
  await main.evaluate(`window.clop.importFiles(${await pick([dropFile])})`);
  const droppedItem = await until(async () => (await main.evaluate('window.clop.state()')).items.find(item => item.source === 'drop' && item.name === 'dropped.png' && item.status !== 'processing'), 'Dropping a file on the drop zone did not give a result', 60000, () => appState(main));
  console.log('Dropped file:', JSON.stringify({ status: droppedItem.status, error: droppedItem.error, originalBytes: droppedItem.originalBytes, outputBytes: droppedItem.outputBytes }));
  assert.equal(droppedItem.status, 'ready', droppedItem.error);
  assert.equal((await stat(dropFile)).size, droppedItem.outputBytes, 'The dropped file should be replaced by its optimised version');
  assert.ok(droppedItem.outputBytes < dropOriginalBytes, 'The dropped file should be smaller after optimising');
  const dropBackups = path.join(profile, 'work', 'backups'), dropBackup = (await readdir(dropBackups)).find(file => file.startsWith('dropped-') && file.endsWith('.png'));
  assert.ok(dropBackup, "The dropped file's original should be in the backups");
  assert.equal(await digest(path.join(dropBackups, dropBackup)), dropOriginal, 'The backup should be the original dropped file');
  assert.deepEqual(await readdir(dropFolder), ['dropped.png'], 'Nothing else should be written next to the dropped file');
  await main.evaluate(`window.clop.restore(${JSON.stringify(droppedItem.id)})`);
  await until(async () => await digest(dropFile) === dropOriginal, 'Restore did not put the dropped file\'s original back', 30000);
  assert.equal((await main.evaluate('window.clop.state()')).notice, undefined, 'Dropping and restoring a file must not show an error');
  await main.evaluate('document.querySelector("input[type=file]").remove()');
  console.log('A file dropped on the drop zone was optimised in place with a backup, and Restore put its original back.');
  // A folder of two PNGs dropped on a preset zone whose pipeline converts to WebP: both files run the zone's pipeline, never the batch
  // window or a plain optimisation, on the files themselves as macOS runs it, so each WebP lands beside its PNG (`manualConvertedImageBehaviour`,
  // `%f`) and the originals are left as they were. The drop goes through the same `runPreset` call (the
  // `run-preset` IPC) the zone in the floating window makes; the files come from a file input that DevTools fills with the folder's
  // path, which gives the page a File for the folder as a drop does. A real drag cannot be used: the zones show only while Ctrl is
  // held during the drag, which the fixtures cannot do.
  const zoneFolder = path.join(profile, 'Zone photos');
  await mkdir(zoneFolder);
  const zoneFiles = ['one.png', 'two.png'].map(name => path.join(zoneFolder, name));
  for (const file of zoneFiles) await sharp({ create: { width: 640, height: 400, channels: 3, background: '#d53a7b' } }).png({ compressionLevel: 0 }).toFile(file);
  const zoneOriginals = await Promise.all(zoneFiles.map(digest));
  const zoneState = await main.evaluate('window.clop.state()');
  assert.ok(zoneState.settings.presetZones.some(zone => zone.id === webpZone.id), 'The preset zone from the settings file should be loaded');
  for (const item of zoneState.items) await main.evaluate(`window.clop.dismiss(${JSON.stringify(item.id)})`);
  await main.evaluate(`window.clop.runPreset(${JSON.stringify(webpZone.id)}, ${await pick([zoneFolder])})`);
  const zoneResults = await until(async () => {
    const items = (await main.evaluate('window.clop.state()')).items.filter(item => item.source === 'drop');
    return items.length === 2 && items.every(item => item.status !== 'processing') && items;
  }, 'Dropping a folder on the preset zone did not give a result for each of its images', 60000, () => appState(main));
  console.log('Preset zone results:', JSON.stringify(zoneResults.map(({ name, status, error, format }) => ({ name, status, error, format }))));
  assert.deepEqual(zoneResults.map(item => [item.name, item.status, item.format]).sort(), [['one.png', 'ready', 'webp'], ['two.png', 'ready', 'webp']], 'Both images should run the zone\'s WebP pipeline');
  // The batch window exists only if an earlier step opened it (the folder drag, skipped on ARM64); with none, the drop cannot have gone there.
  const batchPage = (await pages()).find(page => page.type === 'page' && page.url.includes('batch=1'));
  if (batchPage) {
    const batchAfterZone = await connect(batchPage);
    try { assert.equal((await batchAfterZone.evaluate('window.clopBatch.state()')).files.length, 0, 'A drop on a preset zone must not go to the batch window'); } finally { batchAfterZone.close(); }
  }
  assert.deepEqual(await Promise.all(zoneFiles.map(digest)), zoneOriginals, 'The dropped originals must be left as they were');
  assert.deepEqual((await readdir(zoneFolder)).sort(), ['one.png', 'one.webp', 'two.png', 'two.webp'], 'Each WebP should land beside its original, and nothing else');
  for (const file of ['one.webp', 'two.webp']) assert.equal((await sharp(path.join(zoneFolder, file)).metadata()).format, 'webp');
  assert.equal((await main.evaluate('window.clop.state()')).notice, undefined, 'A drop on a preset zone must not show an error');
  await main.evaluate('document.querySelector("input[type=file]").remove()');
  console.log('A folder dropped on a preset zone converted both of its images to WebP beside them and left the originals alone.');
  console.log('Packaged Windows app smoke passed: automatic file and pixel clipboard processing, original card geometry, in-card format/resize, duplicate protection, repeat copying after text, restore, automatic drag target, copied video, PDF and audio files, an ignored app, a video and an image optimised in place in a watched folder, a clipboard pipeline converting to WebP, a folder dragged from Explorer into the batch window, a dropped file optimised in place and restored, and a folder dropped on a preset zone converting to WebP beside its images.');
} finally {
  console.log('Stopping packaged app and native test helper.');
  try { if (main) await main.send('Runtime.evaluate', { expression: 'window.clop.window("quit")' }); } catch {}
  main?.close(); floating?.close();
  externalClipboard.stop();
  await fixture?.stop();
  if (app.exitCode === null) { await Promise.race([once(app, 'exit'), pause(3000)]); if (app.exitCode === null) app.kill(); }
  console.log('Removing temporary Windows profile.');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  console.log('Desktop smoke cleanup complete.');
}
