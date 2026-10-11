import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ACTION_KINDS, batchMenu, BATCH_ACTIONS, buttonsFor, itemMenu, parseInvocation, planFor, refuseUnavailable, submenu, type CardItem, type Facts, type Invocation, type MenuNode, MENUS } from '../core/cards/actions';
import { photo } from '../core/media/image.fixtures';
import { coverImage, tone } from '../core/media/audio.fixtures';
import { audioMetadata } from '../core/media/audio';
import { probe, type VideoInfo } from '../core/media/detect';
import { photoPDF } from '../core/media/pdf.fixtures';
import { clip, hdrClip } from '../core/media/video.fixtures';
import { FakeEffects } from '../core/pipeline/executor.fixtures';
import { OptimisedMarker } from '../core/marker';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { run } from '../core/run';
import { needTools } from '../core/testing';
import { Workdir } from '../core/workdir';
import { coverArtCard, eachResult, editorLabel, editorProgram, isEditorPath, makesNewCard, mediaFacts, openWithDialog, pageCard, readyIds, runPlan, savePages, thenCopyBack, totalChange, type CardCreation, type CardHost } from './cards';
import { ItemEngine } from './items';
import type { PipelineHost } from './pipelines';
import type { ItemResult } from '../src/types';

const balanced = { mode: 'balanced', format: 'auto', scale: 1 } as const;
const facts: Facts = { native: true, editor: 'Paint', pipelines: [{ id: 'P1', name: 'To WebP' }], hasAudio: true, hdr: true, bitrates: [64, 96, 128], hasCoverArt: true };

async function setup(t: TestContext, settings: Partial<ClopSettings> = {}, ...tools: Parameters<typeof needTools>[1][]) {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'gifsicle', 'ffmpeg', 'ffprobe', 'exiftool', 'gs', ...tools)) return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'clop-cards-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workdir = await new Workdir(path.join(root, 'work')).ensure(), marker = new OptimisedMarker(path.join(root, 'optimised.json'));
  const state = { settings: { ...defaultSettings(), ...settings } as ClopSettings };
  const pipeline: PipelineHost = { env: () => ({ settings: state.settings, workdir, marker, counter: { value: 0 } }), effects: () => new FakeEffects(), counterChanged: () => {}, keep: () => {} };
  const engine = new ItemEngine(path.join(workdir.temp, 'session'), () => state.settings);
  const host: CardHost = { engine, settings: () => state.settings, pipeline };
  const file = (name: string) => path.join(root, name);
  const add = async (source: string) => { const id = await engine.importPath(source, 'file', balanced); assert.equal(engine.get(id).result.status, 'ready', engine.get(id).result.error); return id; };
  /** Runs an invocation on a result the way the main process does, and returns the card afterwards. */
  const act = async (id: string, invocation: Invocation) => {
    const item = engine.get(id).result, plan = planFor(item, parseInvocation(item.kind, invocation));
    assert.notEqual(plan.type, 'ui', `${invocation.action} is the app's part`);
    await runPlan(host, id, plan as Parameters<typeof runPlan>[2]);
    return engine.get(id).result;
  };
  const creation: CardCreation = { engine, settings: () => state.settings, defaults: () => balanced, makeRoom: async () => {}, scratchRoot: root };
  return { root, engine, host, add, act, file, state, creation };
}

/** Every action in a menu; `all` also takes the disabled ones. */
const invocations = (nodes: MenuNode[], all = true): Invocation[] => nodes.flatMap(node => 'separator' in node || 'header' in node || (!all && node.enabled === false) ? [] : [...(node.invoke ? [node.invoke] : []), ...(node.submenu ? invocations(node.submenu, all) : [])]);
/** The first invocation of each action in a menu. */
const firstPerAction = (nodes: MenuNode[]) => {
  const first = new Map<string, Invocation>();
  for (const invocation of invocations(nodes, false)) if (invocation.arg !== 1 && !first.has(invocation.action)) first.set(invocation.action, invocation);
  return [...first.values()];
};
const copyright = async (file: string) => (await run('exiftool', ['-s3', '-Copyright', file])).stdout.toString().trim();

test('every menu entry names an action and value the main process accepts, for every kind', async t => {
  const f = await setup(t); if (!f) return;
  const sources = { image: f.file('a.jpg'), video: f.file('a.mp4'), audio: f.file('a.m4a'), pdf: f.file('a.pdf') };
  await photo(320, 240).jpeg().toFile(sources.image); await clip(sources.video); await coverImage(f.file('c.jpg'), 200, 200); await tone(sources.audio, { cover: f.file('c.jpg'), codec: ['-c:a', 'aac'] }); await writeFile(sources.pdf, await photoPDF());
  for (const [kind, source] of Object.entries(sources)) {
    const item: ItemResult = f.engine.get(await f.add(source)).result;
    assert.equal(item.kind, kind);
    const menu = itemMenu(item, facts), all = invocations(menu);
    assert.ok(all.length > 8, `${kind} has a real menu`);
    for (const invocation of all) assert.deepEqual(parseInvocation(item.kind, invocation), invocation, `${kind}: ${JSON.stringify(invocation)}`);
    for (const name of MENUS) for (const invocation of invocations(submenu(name, item, facts)).filter(invocation => ACTION_KINDS[invocation.action].includes(item.kind))) assert.doesNotThrow(() => parseInvocation(item.kind, invocation), `${kind} ${name}: ${JSON.stringify(invocation)}`);
  }
});

test('each action a kind\'s menu offers does its work on a real file', async t => {
  const f = await setup(t, { stripMetadata: false }, 'gifski'); if (!f) return;
  const jpeg = f.file('photo.jpg'), mp4 = f.file('talk.mp4'), m4a = f.file('song.m4a'), pdf = f.file('doc.pdf');
  await photo(2400, 1800).jpeg({ quality: 100 }).withExif({ IFD0: { Copyright: 'Clop test' } }).toFile(jpeg);
  await clip(mp4, { seconds: 1 }); await coverImage(f.file('cover.jpg'), 400, 400); await tone(m4a, { seconds: 2, cover: f.file('cover.jpg'), codec: ['-c:a', 'aac', '-b:a', '256k'] }); await writeFile(pdf, await photoPDF({ pages: 3 }));
  const checks: Record<string, (before: ItemResult, after: ItemResult, file: string, source: string) => Promise<void> | void> = {
    // The sources have no 'before' from the engine's point of view beyond the freshly optimised card.
    'image:stripExif': async (_, __, file, source) => { assert.equal(await copyright(source), 'Clop test'); assert.equal(await copyright(file), ''); },
    'image:downscale': (before, after) => assert.deepEqual([after.width, after.height], [Math.round(before.width * .9), Math.round(before.height * .9)]),
    'image:fitUnder': (_, after) => assert.ok(after.outputBytes <= 500_000, `${after.outputBytes}`),
    'image:convert': (_, after) => assert.equal(after.format, 'jpeg'),
    'image:aggressive': (_, after) => assert.equal(after.options.mode, 'aggressive'),
    'video:convert': (_, after) => assert.equal(after.format, 'mp4'),
    'video:compression': (before, after) => assert.ok(after.outputBytes > 0 && after.kind === before.kind),
    'audio:convert': (_, after) => assert.equal(after.format, 'm4a'),
    'audio:normalise': async (_, __, file) => assert.ok(((await audioMetadata(file)).durationMs ?? 0) > 1500),
    'audio:aggressive': (_, after) => assert.equal(after.format, 'm4a'),
    'image:compression': (_, after) => assert.deepEqual(after.options.compression, { tier: 'adaptive', factor: 5 }),
    'video:removeAudio': async (_, __, file) => assert.equal((await probe(file) as VideoInfo).hasAudio, false),
    'video:downscale': async (_, __, file) => assert.ok(Math.abs((await probe(file) as VideoInfo).width - 288) <= 2),
    'video:speed': async (_, __, file) => assert.equal(Math.round(((await probe(file)) as VideoInfo).durationMs! / 100), 8),
    'audio:bitrate': async (_, __, file) => assert.ok(((await audioMetadata(file)).bitrate ?? 0) <= 64_000 * 1.2, `${(await audioMetadata(file)).bitrate}`),
    'audio:speed': async (_, __, file) => assert.ok(Math.abs((await audioMetadata(file)).durationMs! - 2000 / 1.25) < 200),
    'audio:coverDownscale': async (_, __, file) => assert.equal((await audioMetadata(file)).hasCoverArt, true),
    'pdf:resolution': (_, after) => assert.equal(after.format, 'pdf'),
  };
  for (const [kind, source] of [['image', jpeg], ['video', mp4], ['audio', m4a], ['pdf', pdf]] as const) {
    const probeId = await f.add(source), menu = itemMenu(f.engine.get(probeId).result, facts);
    await f.engine.dismiss(probeId);
    const actions = firstPerAction(menu).filter(invocation => planFor({ kind, options: balanced }, invocation).type !== 'ui');
    assert.ok(actions.length >= (kind === 'pdf' ? 2 : 6), `${kind}: ${actions.map(a => a.action)}`);
    // The image's "fit under" starts from the smallest size; a bigger photo is needed for 500 KB to bite.
    for (const invocation of actions) {
      const id = await f.add(source), before = structuredClone(f.engine.get(id).result);
      const plan = planFor(before, invocation);
      const after = await f.act(id, invocation);
      assert.equal(after.status, 'ready', `${kind} ${invocation.action}: ${after.error}`);
      const output = f.engine.output(id);
      assert.ok((await stat(output)).size > 0);
      if (!makesNewCard(plan)) await checks[`${kind}:${invocation.action}`]?.(before, after, output, source);
      await f.engine.dismiss(id);
    }
  }
});

test('a pipeline step that fails shows on the card as an error, and restoring brings the original back', async t => {
  const f = await setup(t); if (!f) return;
  const file = f.file('quiet.mp4'); await clip(file, { audio: false });
  const id = await f.add(file);
  await runPlan(f.host, id, { type: 'steps', steps: [{ convert: { to: 'not-a-format', location: 'inPlace' } }], label: 'x' });
  const result = f.engine.get(id).result;
  assert.equal(result.status, 'error');
  assert.match(result.error!, /cannot convert videos to not-a-format/);
  await f.engine.restore(id);
  assert.equal(f.engine.get(id).result.status, 'ready');
});

test('HDR video converts to SDR and a video becomes a GIF', async t => {
  const f = await setup(t, {}, 'gifski'); if (!f) return;
  const hdr = f.file('hdr.mov'); await hdrClip(hdr, { seconds: 1, audio: false });
  const hdrId = await f.add(hdr);
  // Optimising to H.264 tone maps already, and whether that result is kept depends on the encoder's size; the original is HDR.
  await f.engine.restore(hdrId);
  assert.equal((await probe(f.engine.output(hdrId)) as VideoInfo).hdr, true, 'the restored original is HDR');
  const after = await f.act(hdrId, { action: 'hdrToSdr' });
  assert.equal(after.status, 'ready');
  assert.equal((await probe(f.engine.output(hdrId)) as VideoInfo).hdr, false);
  const mp4 = f.file('demo.mp4'); await clip(mp4, { width: 640, height: 360, seconds: 1 });
  const id = await f.add(mp4);
  const gif = await f.act(id, { action: 'toGif', arg: '320x10' });
  assert.deepEqual([gif.kind, gif.format, gif.status], ['image', 'gif', 'ready']);
  assert.ok(gif.width <= 320 && gif.width > 0);
});

test('audio: cover art is extracted as a picture and the audio keeps its picture when it is scaled', async t => {
  const f = await setup(t); if (!f) return;
  const m4a = f.file('song.m4a'); await coverImage(f.file('cover.jpg'), 500, 500); await tone(m4a, { cover: f.file('cover.jpg'), codec: ['-c:a', 'aac'] });
  const id = await f.add(m4a);
  assert.equal(makesNewCard(planFor(f.engine.get(id).result, { action: 'coverArt' })), true);
  const scaled = await f.act(id, { action: 'coverDownscale', arg: 0.5 });
  assert.equal(scaled.kind, 'audio');
  const again = await f.act(id, { action: 'coverDownscale', arg: 0.5 });
  assert.equal(again.status, 'ready', 'a second scale starts from the original picture');
});

test('the renderer cannot ask for an action a kind does not have, or a value the menu does not offer', () => {
  assert.throws(() => parseInvocation('audio', { action: 'removeAudio' }), /does not work on audio/);
  assert.throws(() => parseInvocation('pdf', { action: 'stripExif' }), /does not work on PDFs/);
  assert.throws(() => parseInvocation('image', { action: 'format-c' }), /Choose an action/);
  assert.throws(() => parseInvocation('image', 'downscale'), /Choose an action/);
  assert.throws(() => parseInvocation('image', null), /Choose an action/);
  for (const bad of [0, 0.55, 2, '0.5', NaN, -1]) assert.throws(() => parseInvocation('image', { action: 'downscale', arg: bad }), /does not take that value/, String(bad));
  assert.throws(() => parseInvocation('video', { action: 'toGif', arg: '999x20' }), /does not take that value/);
  assert.throws(() => parseInvocation('video', { action: 'toGif', arg: '800x20; calc' }), /does not take that value/);
  assert.throws(() => parseInvocation('video', { action: 'speed', arg: 11 }), /does not take that value/);
  assert.throws(() => parseInvocation('image', { action: 'convert', arg: 'exe' }), /does not take that value/);
  assert.throws(() => parseInvocation('audio', { action: 'convert', arg: 'webp' }), /does not take that value/);
  assert.throws(() => parseInvocation('image', { action: 'fitUnder', arg: 12345 }), /does not take that value/);
  assert.throws(() => parseInvocation('image', { action: 'dismiss', arg: 'x' }), /does not take that value/);
  assert.throws(() => parseInvocation('image', { action: 'pipeline' }), /does not take that value/);
  assert.throws(() => parseInvocation('image', { action: 'pipeline', arg: 'x'.repeat(201) }), /does not take that value/);
  assert.throws(() => parseInvocation('image', { action: 'menu', arg: 'toString' }), /does not take that value/);
  assert.deepEqual(parseInvocation('image', { action: 'pipeline', arg: 'MINE', extra: 1 }), { action: 'pipeline', arg: 'MINE' });
  assert.deepEqual(parseInvocation('video', { action: 'toGif', arg: '800x20' }), { action: 'toGif', arg: '800x20' });
});

test('menus follow the kind and the card: running cards offer little, audio and PDFs keep to their own actions', () => {
  const card = (kind: CardItem['kind'], extra: Partial<CardItem> = {}): CardItem => ({ kind, status: 'ready', format: kind === 'image' ? 'png' : 'x', animated: false, options: balanced, ...extra });
  const labels = (nodes: MenuNode[]): string[] => nodes.flatMap(node => 'label' in node ? [node.label, ...labels(node.submenu ?? [])] : []);
  assert.deepEqual(labels(itemMenu(card('image', { status: 'processing' }), facts)), ['Stop', 'Restore original', 'Preview', 'Compare (diff)']);
  const audio = labels(itemMenu(card('audio'), facts)), pdf = labels(itemMenu(card('pdf', { pages: 3 }), facts)), video = labels(itemMenu(card('video'), facts)), image = labels(itemMenu(card('image'), facts));
  assert.ok(audio.includes('Compare (A/B)') && audio.includes('Normalise loudness') && audio.includes('Extract cover art') && audio.includes('Change bitrate'));
  assert.ok(!audio.includes('Crop and resize…') && !audio.includes('Strip EXIF metadata') && !audio.includes('Downscale'));
  assert.ok(pdf.includes('Extract pages as images') && pdf.includes('Crop and resize…') && !pdf.includes('Strip EXIF metadata') && !pdf.includes('Convert to…') && !pdf.includes('Compression'));
  assert.ok(labels(itemMenu(card('pdf', { pages: 1 }), facts)).includes('Convert to image'));
  assert.ok(video.includes('Remove audio') && video.includes('Convert HDR to SDR') && video.includes('Convert to GIF') && video.includes('Change playback speed') && video.includes('Re-optimise with encoder') && !video.includes('Aggressive optimisation'));
  assert.ok(!labels(itemMenu(card('video'), { ...facts, hdr: false })).includes('Convert HDR to SDR'));
  assert.ok(image.includes('Strip EXIF metadata') && image.includes('Fit under size') && image.includes('Pass file through pipeline') && image.includes('Edit with Paint') && image.includes('Open with…'));
  assert.ok(!labels(itemMenu(card('image'), { ...facts, editor: undefined })).some(text => text.startsWith('Edit with')));
  assert.ok(!labels(itemMenu(card('image'), { ...facts, native: false })).includes('Open with…'));
  assert.deepEqual(labels(batchMenu([card('image'), card('pdf')])).slice(0, 3), ['Save all to folder…', 'Copy to clipboard', 'Restore all']);
  assert.ok(!labels(batchMenu([card('pdf'), card('audio')])).includes('Strip EXIF metadata'));
  // Saving and copying take the finished results, so they wait while none is.
  const enabled = (items: CardItem[]) => batchMenu(items).flatMap(node => 'label' in node && (node.label === 'Save all to folder…' || node.label === 'Copy to clipboard') ? [node.enabled !== false] : []);
  assert.deepEqual(enabled([{ ...card('image'), status: 'processing' }, { ...card('pdf'), status: 'error' }]), [false, false]);
  assert.deepEqual(enabled([{ ...card('image'), status: 'processing' }, card('pdf')]), [true, true]);
});

test('saving or copying a selection takes the finished results and says when there are none', () => {
  const status: Record<string, string> = { a: 'ready', b: 'processing', c: 'error', d: 'ready' };
  const engine = { has: (id: string) => id in status, get: (id: string) => ({ result: { status: status[id] } }) } as never;
  assert.deepEqual(readyIds(engine, ['a', 'b', 'c', 'd', 'gone']), ['a', 'd']);
  assert.throws(() => readyIds(engine, ['b', 'c']), /Wait for the selected results to finish/);
});

test('corner buttons come from the configured names, by kind, without the ones Windows lacks', () => {
  const item = (kind: CardItem['kind'], extra: Partial<CardItem> = {}): CardItem => ({ kind, status: 'ready', format: 'x', animated: false, options: balanced, ...extra });
  const names = (kind: CardItem['kind'], list: string[], max = 5, panels = true, f = facts) => buttonsFor(item(kind), list, f, max, panels).map(b => b.name + (b.menu ? `>${b.menu}` : b.panel ? `#${b.panel}` : ''));
  const floating = ['downscale', 'restoreOptimise', 'compression', 'aggressiveOptimisation', 'share', 'sendSecurely'];
  assert.deepEqual(names('image', floating), ['downscale#scale', 'restoreOptimise', 'compression#compression', 'aggressiveOptimisation', 'share'], 'sendSecurely has no Windows counterpart');
  assert.deepEqual(names('video', floating), ['downscale>downscale', 'restoreOptimise', 'compression>compression', 'share'], 'no aggressive button on video');
  assert.deepEqual(names('audio', floating), ['downscale>coverDownscale', 'restoreOptimise', 'compression>bitrate', 'aggressiveOptimisation', 'share']);
  assert.deepEqual(names('pdf', floating), ['downscale>resolution', 'restoreOptimise', 'aggressiveOptimisation', 'share']);
  assert.deepEqual(names('image', floating, 5, false), ['downscale>downscale', 'restoreOptimise', 'compression>compression', 'aggressiveOptimisation', 'share'], 'the compact list has no panels');
  assert.deepEqual(names('image', ['crop', 'quickLook', 'showInFinder', 'saveAs', 'copyToClipboard', 'targetSize', 'addToShelf'], 3), ['crop', 'quickLook', 'showInFinder'], 'at most as many as asked');
  assert.deepEqual(names('audio', ['crop', 'targetSize']), ['targetSize>targetSize']);
  assert.deepEqual(names('image', ['showInFinder'], 5, true, { ...facts, native: false }), []);
  assert.equal(buttonsFor(item('image', { restored: true }), ['restoreOptimise'], facts, 5)[0].invoke?.action, 'reoptimise');
  const pipes = { ...facts, pipelines: [{ id: 'IMG', name: 'To WebP' }, { id: 'VID', name: 'Silent' }] };
  assert.deepEqual(buttonsFor(item('image'), ['pipeline:image=IMG;video=VID', 'pipeline:video=VID', 'pipeline:image=GONE', 'pipeline:ANY', 'bogus'], pipes, 5).map(b => [b.label, b.invoke?.arg]), [['To WebP', 'IMG']]);
  assert.deepEqual(buttonsFor(item('video'), ['pipeline:image=IMG;video=VID', 'pipeline:any=IMG'], pipes, 5).map(b => b.invoke?.arg), ['VID', 'IMG']);
});

test('Open with uses the Windows chooser by its System32 path with the file as one argument', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-openwith-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'my file, odd & name.png'); await writeFile(file, 'x');
  const calls: [string, string[]][] = [];
  const saved = process.env.SystemRoot; process.env.SystemRoot = 'C:\\Windows'; t.after(() => { if (saved === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = saved; });
  await openWithDialog(file, 'win32', async (program, args) => { calls.push([program, args]); });
  assert.deepEqual(calls, [[path.join('C:\\Windows', 'System32', 'rundll32.exe'), ['shell32.dll,OpenAs_RunDLL', file]]]);
  await assert.rejects(openWithDialog(file, 'linux'), /Windows only/);
  await assert.rejects(openWithDialog(path.join(dir, 'missing.png'), 'win32', async () => {}), /no longer there/);
  await assert.rejects(openWithDialog('relative.png', 'win32', async () => {}), /no longer there/);
});

const clean = async () => false, exists = async () => true;
test('Edit with fails closed: only the full path of an existing .exe that passes every check is started, and that exact path comes back', async () => {
  const win = { platform: 'win32' as const, marked: clean, isFile: exists, canonical: async (file: string) => file };
  assert.equal(await editorProgram('"C:\\Program Files\\GIMP\\gimp.exe"', win), 'C:\\Program Files\\GIMP\\gimp.exe');
  // A name is never looked up: no Start menu, no App Paths, nothing relative.
  for (const name of ['gimp', 'gimp.exe', 'Editor', '..\\editor.exe', '.\\editor.exe', 'C:editor.exe', 'Microsoft.Paint_8wekyb3d8bbwe!App', 'C:\\Apps\\editor', 'C:\\Apps\\editor.bat', 'C:\\Apps\\editor.exe.lnk', 'https://example.com/x.exe']) {
    await assert.rejects(editorProgram(name, win), /full path of a \.exe/, name);
    assert.equal(isEditorPath(name), false, name);
  }
  assert.equal(isEditorPath('"C:\\Apps\\Editor.EXE"'), true);
  await assert.rejects(editorProgram('C:\\Apps\\missing.exe', { ...win, isFile: async () => false }), /was not found/);
  for (const launcher of ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\explorer.exe', 'C:\\Windows\\System32\\rundll32.exe', 'C:\\Tools\\node.exe', 'C:\\Windows\\System32\\wscript.exe']) await assert.rejects(editorProgram(launcher, win), /runs other programs/, launcher);
  await assert.rejects(editorProgram('C:\\Users\\me\\Downloads\\editor.exe', { ...win, marked: async () => true }), /downloaded from the internet/);
  await assert.rejects(editorProgram('C:\\Apps\\editor.exe', { ...win, marked: async () => { throw new Error('Clop could not check whether it was downloaded'); } }), /could not check/);
  await assert.rejects(editorProgram('C:\\Users\\me\\Desktop\\editor.exe', { ...win, watched: ['C:\\Users\\me\\Desktop'] }), /inside the watched folder/);
  assert.equal(await editorProgram('C:\\Users\\me\\Desktopper\\editor.exe', { ...win, watched: ['C:\\Users\\me\\Desktop'] }), 'C:\\Users\\me\\Desktopper\\editor.exe');  // Streams, network shares and device paths are not programs on a local drive.
  for (const odd of ['C:\\Users\\me\\Downloads\\a.txt:evil.exe', '\\\\host\\share\\x.exe', '\\\\?\\C:\\Apps\\x.exe', '\\\\.\\C:\\Apps\\x.exe']) {
    await assert.rejects(editorProgram(odd, win), /full path of a \.exe/, odd);
    assert.equal(isEditorPath(odd), false, odd);
  }
  // Every check runs on what the path really is, and that is what comes back.
  const through = (map: Record<string, string>) => ({ ...win, canonical: async (file: string) => map[file] ?? file });
  await assert.rejects(editorProgram('C:\\Apps\\J\\editor.exe', { ...through({ 'C:\\Apps\\J\\editor.exe': 'C:\\Users\\me\\Desktop\\editor.exe', 'C:\\Users\\me\\Desktop': 'C:\\Users\\me\\Desktop' }), watched: ['C:\\Users\\me\\Desktop'] }), /inside the watched folder/, 'a junction into a watched folder');
  await assert.rejects(editorProgram('C:\\Users\\RAMI~1\\Desktop\\x.exe', { ...through({ 'C:\\Users\\RAMI~1\\Desktop\\x.exe': 'C:\\Users\\Rami\\Desktop\\x.exe' }), watched: ['C:\\Users\\Rami\\Desktop'] }), /inside the watched folder/, 'a short name');
  await assert.rejects(editorProgram('C:\\Apps\\alias.exe', through({ 'C:\\Apps\\alias.exe': 'C:\\Windows\\System32\\cmd.exe' })), /runs other programs/, 'a link to a launcher');
  await assert.rejects(editorProgram('C:\\Apps\\remote.exe', through({ 'C:\\Apps\\remote.exe': '\\\\host\\share\\remote.exe' })), /local drive/, 'a link to a network share');
  await assert.rejects(editorProgram('C:\\Apps\\gone.exe', { ...win, canonical: async () => { throw new Error('ENOENT'); } }), /local drive/);
  assert.equal(await editorProgram('C:\\Apps\\link.exe', through({ 'C:\\Apps\\link.exe': 'C:\\Program Files\\Real\\real.exe' })), 'C:\\Program Files\\Real\\real.exe');
});

test('a window that asks for Edit with when the menu hides it is refused the same way', async () => {
  const win = { platform: 'win32' as const, marked: clean, canonical: async (file: string) => file };
  // The menu shows the entry only for an existing .exe path (`cardFacts`); the main process runs `editorProgram` on the same setting.
  const image = { kind: 'image' as const, status: 'ready' as const, format: 'png', animated: false, options: balanced };
  const shows = async (setting: string, exists_: boolean) => itemMenu(image, { native: true, editor: await editorLabel(setting, async () => exists_) }).some(node => 'label' in node && node.label.startsWith('Edit with'));
  for (const [setting, exists_, reason] of [['', true, /No editor app/], ['gimp', true, /full path/], ['C:\\Apps\\gone.exe', false, /was not found/], ['C:\\Windows\\System32\\cmd.exe', true, /runs other programs/]] as const) {
    await assert.rejects(editorProgram(setting, { ...win, isFile: async () => exists_ }), reason, setting);
    // The entry is hidden exactly when the main process would refuse for lack of a program (not for the later safety checks, which it also applies).
    assert.equal(await shows(setting, exists_), reason.source === 'runs other programs', setting);
  }
  assert.equal(await shows('"C:\\Program Files\\GIMP\\gimp.exe"', true), true);
  assert.equal(await editorProgram('"C:\\Program Files\\GIMP\\gimp.exe"', { ...win, isFile: async () => true }), 'C:\\Program Files\\GIMP\\gimp.exe');
  assert.equal(await shows('\\\\host\\share\\x.exe', true), false);
});

test('the table refuses what the menu disables, and values the menu never offers', () => {
  const video = { kind: 'video' as const }, audio = { kind: 'audio' as const };
  assert.match(refuseUnavailable(video, { action: 'removeAudio' }, { native: true, hasAudio: false })!, /no audio/);
  assert.equal(refuseUnavailable(video, { action: 'removeAudio' }, { native: true, hasAudio: true }), undefined);
  assert.match(refuseUnavailable(video, { action: 'hdrToSdr' }, { native: true, hdr: false })!, /not HDR/);
  assert.match(refuseUnavailable(video, { action: 'hdrToSdr' }, { native: true })!, /not HDR/);
  assert.equal(refuseUnavailable(video, { action: 'hdrToSdr' }, { native: true, hdr: true }), undefined);
  assert.match(refuseUnavailable(audio, { action: 'coverArt' }, { native: true, hasCoverArt: false })!, /no cover art/);
  assert.match(refuseUnavailable(audio, { action: 'bitrate', arg: 96 }, { native: true, bitrates: [64, 128] })!, /no such bitrate/);
  assert.equal(refuseUnavailable(audio, { action: 'bitrate', arg: 128 }, { native: true, bitrates: [64, 128] }), undefined);
  assert.throws(() => parseInvocation('video', { action: 'compression', arg: 'adaptive' }), /does not take that value/);
  assert.deepEqual(parseInvocation('image', { action: 'compression', arg: 'adaptive' }), { action: 'compression', arg: 'adaptive' });
  assert.throws(() => parseInvocation('audio', { action: 'bitrate', arg: 33 }), /does not take that value/);
  assert.throws(() => parseInvocation('audio', { action: 'downscale', arg: 0.5 }), /does not work on audio/);
});

test('the batch menu offers what works on several results and the batch actions are the ones it names', () => {
  const card = (kind: CardItem['kind']): CardItem => ({ kind, status: 'ready', format: 'x', animated: false, options: balanced });
  const labels = (nodes: MenuNode[]): string[] => nodes.flatMap(node => 'label' in node ? [node.label] : []);
  const all = labels(batchMenu([card('image'), card('video'), card('audio'), card('pdf')], { native: true, hdr: true, bitrates: [64, 96] }));
  for (const wanted of ['Save all to folder…', 'Copy to clipboard', 'Restore all', 'Downscale', 'Change bitrate', 'Change playback speed', 'Aggressive optimisation', 'Convert HDR to SDR', 'Strip EXIF metadata', 'Dismiss']) assert.ok(all.includes(wanted), wanted);
  const pdfs = labels(batchMenu([card('pdf'), card('audio')], { native: true }));
  assert.ok(!pdfs.includes('Strip EXIF metadata') && !pdfs.includes('Downscale') && !pdfs.includes('Convert HDR to SDR'));
  const invoked = new Set<string>();
  const walk = (nodes: MenuNode[]) => { for (const node of nodes) if ('label' in node) { if (node.invoke) invoked.add(node.invoke.action); if (node.submenu) walk(node.submenu); } };
  walk(batchMenu([card('image'), card('video'), card('audio')], { native: true, hdr: true, bitrates: [64] }));
  for (const action of invoked) assert.ok(BATCH_ACTIONS.includes(action as never), action);
});

test('every offered value of an action works, not just the first', async t => {
  const f = await setup(t); if (!f) return;
  const jpeg = f.file('p.jpg'), mp4 = f.file('v.mp4'), m4a = f.file('a.m4a');
  await photo(1200, 800).jpeg({ quality: 95 }).toFile(jpeg); await clip(mp4, { seconds: 1 }); await tone(m4a, { seconds: 1, codec: ['-c:a', 'aac', '-b:a', '256k'] });
  const image = await f.add(jpeg);
  for (const arg of [0.9, 0.5, 0.1]) { const r = await f.act(image, { action: 'downscale', arg }); assert.equal(r.width, Math.round(1200 * arg)); }
  for (const arg of ['adaptive', 'lossless', 10, 90] as const) assert.equal((await f.act(image, { action: 'compression', arg })).status, 'ready', String(arg));
  assert.equal((await f.act(image, { action: 'aggressive' })).options.mode, 'aggressive');
  for (const [arg, format] of [['webp', 'webp'], ['png', 'png'], ['gif', 'gif'], ['avif', 'avif'], ['jpeg', 'jpeg']] as const) assert.equal((await f.act(image, { action: 'convert', arg })).format, format, arg);
  const video = await f.add(mp4);
  for (const arg of [0.5, 1.25, 10]) assert.equal((await f.act(video, { action: 'speed', arg })).status, 'ready', String(arg));
  for (const arg of ['fast', 'slowHighQuality', 'visuallyLossless']) assert.equal((await f.act(video, { action: 'encoder', arg })).status, 'ready', arg);
  for (const arg of ['lossless', 50] as const) assert.equal((await f.act(video, { action: 'compression', arg })).status, 'ready', String(arg));
  assert.equal((await f.act(video, { action: 'convert', arg: 'mov' })).format, 'mov');
  const audio = await f.add(m4a);
  for (const arg of [64, 96, 128]) assert.equal((await f.act(audio, { action: 'bitrate', arg })).status, 'ready', String(arg));
  for (const lufs of [-12, -14, -16, -19, -23]) assert.equal((await f.act(audio, { action: 'normalise', arg: lufs })).status, 'ready', String(lufs));
  assert.equal((await f.act(audio, { action: 'convert', arg: 'mp3' })).format, 'mp3');
  assert.equal((await f.act(audio, { action: 'aggressive' })).status, 'ready');
});

test('cover art and PDF pages become cards of their own, and facts come from the file', async t => {
  const f = await setup(t); if (!f) return;
  const m4a = f.file('song.m4a'), mp4 = f.file('clip.mp4'), pdf = f.file('doc.pdf'), one = f.file('one.pdf');
  await coverImage(f.file('c.jpg'), 300, 300); await tone(m4a, { cover: f.file('c.jpg'), codec: ['-c:a', 'aac'] });
  await clip(mp4, { seconds: 1 }); await writeFile(pdf, await photoPDF({ pages: 3 })); await writeFile(one, await photoPDF({ pages: 1 }));
  const song = await f.add(m4a);
  const cover = await coverArtCard(f.creation, song);
  assert.notEqual(cover, song);
  assert.deepEqual([f.engine.get(cover).result.kind, f.engine.get(cover).result.status, f.engine.get(song).result.kind], ['image', 'ready', 'audio']);
  const page = await pageCard(f.creation, await f.add(one), 'png');
  assert.deepEqual([f.engine.get(page).result.kind, f.engine.get(page).result.format], ['image', 'png']);
  const folder = path.join(f.root, 'pages'), written = await savePages(f.creation, await f.add(pdf), 'jpeg', folder);
  assert.equal(written.length, 3);
  for (const file of written) assert.ok((await stat(file)).size > 0 && file.startsWith(folder));
  assert.deepEqual(await mediaFacts(f.engine.output(song), 'audio').then(x => [x.hasCoverArt, x.bitrates!.includes(128)]), [true, true]);
  assert.deepEqual(await mediaFacts(f.engine.output(await f.add(mp4)), 'video').then(x => [x.hasAudio, x.hdr]), [true, false]);
  assert.deepEqual(await mediaFacts(pdf, 'pdf'), {});
});

test('a batch action skips the results it does not fit without a word, reports the ones that failed, and says which finished', async () => {
  const ran: string[] = [];
  const outcome = await eachResult(['sdr', 'hdr', 'broken', 'hdr2'], {
    name: id => id.toUpperCase(),
    skip: async id => id === 'sdr',
    run: async id => { if (id === 'broken') throw new Error('The encoder failed.'); ran.push(id); },
  });
  assert.deepEqual(ran, ['hdr', 'hdr2']);
  assert.deepEqual(outcome.done, ['hdr', 'hdr2'], 'a skipped or failed result is not copied back');
  assert.deepEqual(outcome.failures, ['BROKEN: The encoder failed.'], 'a skip is not a failure');
  const refused = await eachResult(['a'], { name: id => id, skip: async () => { throw new Error('facts unreadable'); }, run: async () => {} });
  assert.deepEqual(refused, { done: [], failures: ['a: facts unreadable'] });
});

test('a video\'s downscale and speed are totals: 50% then 80% is 80%, and 1x undoes 2x', async t => {
  const f = await setup(t); if (!f) return;
  const mp4 = f.file('long.mp4'); await clip(mp4, { width: 640, height: 360, seconds: 2 });
  const id = await f.add(mp4), video = async () => await probe(f.engine.output(id)) as VideoInfo;
  assert.equal((await video()).width, 640);
  await f.act(id, { action: 'downscale', arg: 0.5 });
  assert.equal((await video()).width, 320);
  assert.equal(f.engine.get(id).result.options.scale, 0.5);
  // Bigger than it is now: from the original, not 80% of 50%.
  await f.act(id, { action: 'downscale', arg: 0.8 });
  assert.ok(Math.abs((await video()).width - 512) <= 2, `${(await video()).width}`);
  await f.act(id, { action: 'speed', arg: 2 });
  const fast = await video();
  assert.ok(Math.abs(fast.width - 512) <= 2 && fast.durationMs! < 1300, `${fast.width} ${fast.durationMs}`);
  assert.equal(f.engine.get(id).result.options.speed, 2);
  // 1x applies the opposite of the 2x it had, and the size stays.
  await f.act(id, { action: 'speed', arg: 1 });
  const slow = await video();
  assert.ok(Math.abs(slow.width - 512) <= 2 && slow.durationMs! > 1700, `${slow.width} ${slow.durationMs}`);
  // A size bigger than the current one with a speed in place starts again from the original and keeps the speed.
  await f.act(id, { action: 'speed', arg: 2 });
  await f.act(id, { action: 'downscale', arg: 1 });
  const back = await video();
  assert.ok(back.width === 640 && back.durationMs! < 1300, `${back.width} ${back.durationMs}`);
  assert.deepEqual([f.engine.get(id).result.options.scale, f.engine.get(id).result.options.speed], [1, 2]);
});

test('the steps for a total are the change from what the result has had, and none when it is there already', () => {
  const down = (factor: number) => [{ downscale: { factor } }] as never, speed = (factor: number) => [{ changeSpeed: { factor } }] as never;
  assert.deepEqual(totalChange(down(0.5), { scale: 1 }), { steps: down(0.5), tracked: { scale: 0.5 } });
  assert.deepEqual(totalChange(down(0.4), { scale: 0.8 }), { steps: down(0.5), tracked: { scale: 0.4 } });
  assert.deepEqual(totalChange(down(0.5), { scale: 0.5 }), { steps: [] });
  assert.deepEqual(totalChange(down(0.8), { scale: 0.5 }), { steps: down(0.8), tracked: { scale: 0.8, speed: 1 }, restoreFirst: true });
  assert.deepEqual(totalChange(down(1), { scale: 0.5, speed: 2 }), { steps: speed(2), tracked: { scale: 1, speed: 2 }, restoreFirst: true });
  assert.deepEqual(totalChange(speed(1.5), { scale: 1, speed: 1.25 })?.steps, speed(1.5 / 1.25));
  assert.deepEqual(totalChange(speed(1), { scale: 1, speed: 2 }), { steps: speed(0.5), tracked: { speed: 1 } });
  assert.deepEqual(totalChange(speed(1), { scale: 1 }), { steps: [] });
  assert.equal(totalChange([{ removeAudio: {} }] as never, { scale: 1 }), undefined);
});

test('saving PDF pages keeps what the folder holds and writes the pages that could not be made smaller', async t => {
  const f = await setup(t); if (!f) return;
  const pdf = f.file('doc.pdf'), folder = path.join(f.root, 'pages');
  await writeFile(pdf, await photoPDF({ pages: 2 }));
  await mkdir(folder);
  // A file of the user's under the name page 1 would take.
  const first = (await savePages(f.creation, await f.add(pdf), 'jpeg', path.join(f.root, 'probe')))[0], name = path.basename(first);
  await writeFile(path.join(folder, name), 'mine');
  const written = await savePages(f.creation, await f.add(pdf), 'jpeg', folder);
  assert.equal(await readFile(path.join(folder, name), 'utf8'), 'mine', 'an existing file is not replaced');
  assert.equal(written.length, 2);
  assert.equal(new Set(written).size, 2);
  for (const file of written) assert.ok((await stat(file)).size > 100 && path.dirname(file) === folder, file);
  // A lossless setting leaves a page as it was rendered, which is in the scratch folder: it is copied to the folder.
  f.state.settings = { ...f.state.settings, imageCompression: { tier: 'lossless', factor: 5 } };
  const again = await savePages(f.creation, await f.add(pdf), 'png', path.join(f.root, 'lossless'));
  for (const file of again) assert.ok((await stat(file)).size > 100 && path.dirname(file) === path.join(f.root, 'lossless'), file);
});

test('a result goes back on the clipboard with the sequence read before the work began', async () => {
  let clipboard = 5;
  const given: (number | undefined)[] = [];
  const result = await thenCopyBack(async () => clipboard, async () => { clipboard = 6; return 'done'; }, async sequence => { given.push(sequence); });
  assert.deepEqual([result, given], ['done', [5]], 'a copy made during the work is newer than the sequence the write expects');
  await assert.rejects(thenCopyBack(async () => clipboard, async () => { throw new Error('encoder failed'); }, async sequence => { given.push(sequence); }), /encoder failed/);
  assert.equal(given.length, 1, 'a failed action puts nothing back');
  assert.deepEqual(await thenCopyBack(async () => { throw new Error('no helper'); }, async () => 1, async sequence => { given.push(sequence); }), 1);
  assert.deepEqual(given, [5, undefined], 'without a helper the write has no sequence to check');
});
