import assert from 'node:assert/strict';
import { PDFDocument } from '@cantoo/pdf-lib';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import { OptimisedMarker } from '../marker';
import { graphic, photo } from '../media/image.fixtures';
import { photoPDF } from '../media/pdf.fixtures';
import { clip } from '../media/video.fixtures';
import { FakeEffects } from '../pipeline/executor.fixtures';
import { parseSteps } from '../pipeline/parser';
import { defaultSettings, type ClopSettings } from '../settings/schema';
import { needTools } from '../testing';
import { shellEffects } from '../shell-effects';
import { Workdir } from '../workdir';
import { fileURL, type OptimisationRequest, type ServerMessage } from './protocol';
import { ClopService, cropSizeText, factorText, isPublicAddress, publicLookup, requestSteps, type ServiceDeps } from './service';

async function setup(t: TestContext, deps: Partial<ServiceDeps> = {}, values: Partial<ClopSettings> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-service-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = { current: { ...defaultSettings(), ...values }, get: () => store.current, async update<T>(change: (current: ClopSettings) => { patch?: unknown; result: T }) { const { patch, result } = change(store.current); if (patch !== undefined) store.current = { ...store.current, ...(patch as object) }; return { settings: store.current, result }; } };
  const workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const copied: string[][] = [];
  const service = new ClopService({ store, workdir, effects: new FakeEffects(), marker: new OptimisedMarker(path.join(dir, 'optimised.json')), copyFiles: async files => { copied.push(files); }, ...deps });
  const send = async (request: Partial<OptimisationRequest> & { urls: string[] }) => {
    const messages: ServerMessage[] = [];
    await service.handle({ kind: 'optimise', request: { id: '1', hideFloatingResult: true, copyToClipboard: false, aggressiveOptimisation: false, source: 'cli', ...request } }, message => messages.push(message));
    return messages;
  };
  return { dir, store, workdir, service, send, copied, file: (name: string) => path.join(dir, name) };
}
const answers = (messages: ServerMessage[]) => messages.filter(m => m.kind !== 'progress');

test('a plain request optimises in place with a backup and answers once per input, then done', async t => {
  if (!needTools(t, 'pngquant')) return;
  const s = await setup(t);
  const input = s.file('shot.png');
  await graphic(400, 300).png({ compressionLevel: 0 }).toFile(input);
  const before = (await stat(input)).size;
  const messages = await s.send({ urls: [fileURL(input), fileURL(s.file('missing.png'))] });
  const [first, second, done] = answers(messages);
  assert.equal(done.kind, 'done');
  const response = [first, second].find(m => m.kind === 'response');
  assert.ok(response?.kind === 'response');
  assert.deepEqual({ ...response.response, newBytes: 0 }, { path: input, forURL: fileURL(input), oldBytes: before, newBytes: 0, oldWidthHeight: [400, 300], newWidthHeight: [400, 300] });
  assert.equal(response.response.newBytes, (await stat(input)).size);
  assert.ok(response.response.newBytes < before);
  const error = [first, second].find(m => m.kind === 'error');
  assert.deepEqual(error, { kind: 'error', error: { error: `File not found: ${s.file('missing.png')}`, forURL: fileURL(s.file('missing.png')) } });
  assert.equal((await readdir(s.workdir.backups)).length, 1);
  assert.deepEqual(await readdir(s.workdir.temp), [], 'work files of placed results are removed');
  assert.ok(messages.some(m => m.kind === 'progress' && m.fractionCompleted === 1));
});

test('crop, downscale and an output template with %z and %s place a new file and leave the original', async t => {
  if (!needTools(t, 'pngquant')) return;
  const s = await setup(t);
  const input = s.file('photo.png');
  await photo(800, 600).png().toFile(input);
  const [cropped] = answers(await s.send({ urls: [fileURL(input)], size: { width: 200, height: 100, name: '', longEdge: false, smartCrop: false }, output: path.join(s.dir, 'out', '%f-%z') }));
  assert.ok(cropped.kind === 'response');
  assert.equal(cropped.response.path, path.join(s.dir, 'out', 'photo-200x100.png'));
  assert.deepEqual(cropped.response.newWidthHeight, [200, 100]);
  const [scaled] = answers(await s.send({ urls: [fileURL(input)], downscaleFactor: 0.5, output: path.join(s.dir, '%f@%sx') }));
  assert.ok(scaled.kind === 'response');
  assert.equal(scaled.response.path, path.join(s.dir, 'photo@0.5x.png'));
  assert.deepEqual(scaled.response.newWidthHeight, [400, 300]);
  assert.deepEqual((await sharp(input).metadata()).width, 800, 'the original is untouched');
});

test('a request pipeline runs inline steps exactly, and a saved one by name', async t => {
  if (!needTools(t, 'pngquant')) return;
  const s = await setup(t);
  const input = s.file('logo.png');
  await graphic(300, 200).png().toFile(input);
  const [converted] = answers(await s.send({ urls: [fileURL(input)], pipeline: 'convert(to: webp)' }));
  assert.ok(converted.kind === 'response');
  assert.equal(converted.response.path, s.file('logo.webp'));
  assert.equal(converted.response.convertedFrom, input);
  assert.equal((await sharp(s.file('logo.webp')).metadata()).format, 'webp');
  s.store.current.savedPipelines = [{ id: 'HALF', name: 'Half', steps: parseSteps('downscale(factor: 0.5, location: "%f-half")'), skipOptimisation: true, hideResult: false }];
  const [saved] = answers(await s.send({ urls: [fileURL(input)], pipeline: 'half' }));
  assert.ok(saved.kind === 'response');
  assert.equal(saved.response.path, s.file('logo-half.png'));
  assert.deepEqual(saved.response.newWidthHeight, [150, 100]);
  const [refused] = answers(await s.send({ urls: [fileURL(input)], pipeline: 'crop(width: banana)' }));
  assert.ok(refused.kind === 'error');
  assert.match(refused.error.error, /width/);
});

test('agents are refused before any file is touched unless the user allowed them', async t => {
  const s = await setup(t);
  const input = s.file('a.png');
  await graphic(50, 50).png().toFile(input);
  const before = (await stat(input)).mtimeMs;
  const messages = await s.send({ urls: [fileURL(input)], origin: 'mcp' });
  assert.deepEqual(messages, [{ kind: 'error', error: { error: 'Clop is not accepting changes from agents. Ask the user to allow it in Clop Settings, MCP.', forURL: fileURL(input) } }, { kind: 'done' }]);
  s.store.current.mcpEnabled = true;
  const scripted = await s.send({ urls: [fileURL(input)], origin: 'mcp', pipeline: 'runScript(code: "echo hi")' });
  assert.match((scripted[0] as { error: { error: string } }).error.error, /script steps/);
  assert.equal((await stat(input)).mtimeMs, before);
  const review = await s.send({ urls: [fileURL(input)], prepareInBatch: true });
  assert.match((review[0] as { error: { error: string } }).error.error, /needs Clop running/);
  assert.equal((await stat(input)).mtimeMs, before);
});

test('--review sends the files to the batch window and optimises nothing; a window that refuses is reported per input', async t => {
  const added: [string[], boolean][] = [];
  let refuse: string | undefined;
  const s = await setup(t, { prepareInBatch: async (files, aggressive) => { if (refuse) throw new Error(refuse); added.push([files, aggressive]); } });
  const input = s.file('a.png');
  await graphic(50, 50).png().toFile(input);
  const before = (await stat(input)).mtimeMs;
  assert.deepEqual(await s.send({ urls: [fileURL(input), fileURL(s.file('b.png'))], prepareInBatch: true, aggressiveOptimisation: true }), [{ kind: 'done' }]);
  assert.deepEqual(added, [[[input, s.file('b.png')], true]]);
  assert.equal((await stat(input)).mtimeMs, before);
  assert.deepEqual(await readdir(s.workdir.backups), []);
  refuse = 'A batch is running. Wait for it to finish or cancel it before adding files.';
  assert.deepEqual(await s.send({ urls: [fileURL(input)], prepareInBatch: true }), [{ kind: 'error', error: { error: refuse, forURL: fileURL(input) } }, { kind: 'done' }]);
  const link = await s.send({ urls: ['https://example.com/a.png'], prepareInBatch: true });
  assert.match((link[0] as { error: { error: string } }).error.error, /on this computer/);
  // The MCP gate still comes first.
  assert.match(((await s.send({ urls: [fileURL(input)], prepareInBatch: true, origin: 'mcp' }))[0] as { error: { error: string } }).error.error, /not accepting changes from agents/);
});

test('an agent\'s request that names a network share or a device anywhere is refused before any file is touched', async t => {
  const s = await setup(t, {}, { mcpEnabled: true, mcpAllowScriptSteps: true });
  const input = s.file('a.png');
  await graphic(50, 50).png().toFile(input);
  const before = (await stat(input)).mtimeMs, local = fileURL(input);
  const requests: (Partial<OptimisationRequest> & { urls: string[] })[] = [
    { urls: ['file://server/share/a.png'] }, { urls: [local], output: '\\\\server\\share\\%f' }, { urls: [local], output: '%e\\\\host\\share\\%f' }, { urls: [local], placement: { optimised: 'sameFolder', sameFolderTemplate: '%e//host/share/%f' } },
    { urls: [local], pipeline: 'if(regex: "^(z*)") -> copy(to: "$1//host/share/")' },
    { urls: [local], placement: { optimised: 'specificFolder', specificFolderTemplate: '//server/share/%f' } },
    ...['copy(to: "\\\\\\\\server\\\\share\\\\")', 'move(to: "//server/share/")', 'watermark(image: "\\\\\\\\server\\\\share\\\\logo.png")', 'delete(path: "\\\\\\\\?\\\\UNC\\\\server\\\\share")', 'optimise(location: "\\\\\\\\.\\\\C:\\\\out\\\\%f")', 'runScript(path: "//server/share/x.ps1")', 'openWith(app: "\\\\\\\\server\\\\share\\\\x.exe")'].map(pipeline => ({ urls: [local], pipeline })),
  ];
  for (const request of requests) {
    const messages = await s.send({ ...request, origin: 'mcp' });
    assert.equal(messages.length, 2, JSON.stringify(request));
    assert.match((messages[0] as { error: { error: string } }).error.error, /is on a network share or a device\. Agents may only use files and folders on this PC's own drives/, JSON.stringify(request));
  }
  assert.equal((await stat(input)).mtimeMs, before);
  assert.deepEqual(await readdir(s.workdir.backups), []);
});

test('--review from an agent applies the same path guard before the batch window looks the files up', async t => {
  const added: string[][] = [];
  const s = await setup(t, { prepareInBatch: async files => { added.push(files); } }, { mcpEnabled: true });
  const input = s.file('a.png');
  await graphic(50, 50).png().toFile(input);
  const refused = /is on a network share or a device\. Agents may only use files and folders on this PC's own drives/;
  for (const url of ['file://server/share/a.png', 'file:////server/share/dir', 'file:///%5C%5Cserver%5Cshare%5Ca.png']) {
    const messages = await s.send({ urls: [fileURL(input), url], prepareInBatch: true, origin: 'mcp' });
    assert.match((messages[0] as { error: { error: string } }).error.error, refused, url);
    assert.equal(messages.length, 3, 'one refusal per input, then done');
  }
  assert.deepEqual(added, [], 'the batch window was never asked to look at a remote path');
  // A local file from an agent, and a person's own request, still reach the window.
  assert.deepEqual(await s.send({ urls: [fileURL(input)], prepareInBatch: true, origin: 'mcp' }), [{ kind: 'done' }]);
  assert.deepEqual(added, [[input]]);
});

test('an agent\'s download reaches only the internet: a host on this PC or its network is refused, a person\'s is fetched', async t => {
  if (!needTools(t, 'pngquant')) return;
  const s = await setup(t, {}, { mcpEnabled: true });
  const png = await graphic(60, 40).png({ compressionLevel: 0 }).toBuffer();
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'image/png' }); response.end(png); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/shot.png`;
  const [refused] = await s.send({ urls: [url], origin: 'mcp' });
  assert.match((refused as { error: { error: string } }).error.error, /^Download failed: 127\.0\.0\.1 is on this PC or its local network, and agents may only download from the internet\.$/);
  const [fetched] = answers(await s.send({ urls: [url] }));
  assert.equal(fetched.kind, 'response', JSON.stringify(fetched));
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});

test('an agent\'s download connects only to an address that passed the check, whatever the name answers next', async t => {
  const asked: string[] = [];
  const s = await setup(t, { resolve: async host => { asked.push(host); return host === 'mixed.test' ? [{ address: '93.184.216.34' }, { address: '127.0.0.1' }] : [{ address: '127.0.0.1' }]; } }, { mcpEnabled: true });
  let hits = 0;
  const server = createServer((_request, response) => { hits++; response.end('secret'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  for (const host of ['mixed.test', 'plain.test']) {
    const [refused] = await s.send({ urls: [`http://${host}:${port}/a.png`], origin: 'mcp' });
    assert.match((refused as { error: { error: string } }).error.error, new RegExp(`^Download failed: ${host} is on this PC or its local network`));
  }
  assert.deepEqual([hits, asked], [0, ['mixed.test', 'plain.test']], 'the name is looked up once, by the connection itself, and nothing reached the server');
  // The connection gets the address that was checked, not a second answer: a name that turns to loopback after the first lookup does not matter.
  const answers = [[{ address: '93.184.216.34' }], [{ address: '127.0.0.1' }]];
  const lookup = publicLookup(async () => answers.shift()!);
  const first = await new Promise<unknown>(resolve => lookup('rebind.test', { all: true }, (error, found) => resolve(error ?? found)));
  assert.deepEqual(first, [{ address: '93.184.216.34', family: 4 }]);
  const single = await new Promise<unknown[]>(resolve => publicLookup(async () => [{ address: '2606:4700:4700::1111' }])('v6.test', {}, (error, address, family) => resolve([error, address, family])));
  assert.deepEqual(single, [null, '2606:4700:4700::1111', 6]);
});

test('a plain request turns a video of a type formatsToConvertToMP4 lists into an MP4, and leaves an unlisted one in its container', async t => {
  if (!needTools(t, 'ffmpeg', 'ffprobe')) return;
  const listed = await setup(t), unlisted = await setup(t, {}, { formatsToConvertToMP4: [] });
  for (const [s, extension] of [[listed, '.mp4'], [unlisted, '.mov']] as const) {
    const input = await clip(s.file('take.mov'), { audio: 'aac' });
    const [done] = answers(await s.send({ urls: [fileURL(input)] }));
    assert.ok(done.kind === 'response', JSON.stringify(done));
    assert.equal(path.extname(done.response.path), extension, JSON.stringify(done));
  }
});

test('a request that shows its result lets the app optimise it with a card, then places that result', async t => {
  const seen: string[] = [];
  const s = await setup(t, {
    async withCard(file, kind, request) {
      seen.push(`${kind}:${request.hideFloatingResult}`);
      const out = path.join(path.dirname(file), 'card', path.basename(file));
      await mkdir(path.dirname(out), { recursive: true });
      await sharp(file).resize(10).toFile(out);
      return out;
    },
  });
  const input = s.file('a.png');
  await graphic(100, 80).png().toFile(input);
  const [shown] = answers(await s.send({ urls: [fileURL(input)], hideFloatingResult: false, copyToClipboard: true }));
  assert.deepEqual(seen, ['image:false']);
  assert.ok(shown.kind === 'response');
  assert.deepEqual(shown.response.newWidthHeight, [10, 8]);
  assert.deepEqual(s.copied, [[input]]);
});

test('a card that placed its result itself is the answer, and the service places nothing more', async t => {
  const s = await setup(t, { async withCard(file) { return { placed: file }; } });
  const input = s.file('a.png');
  await graphic(100, 80).png().toFile(input);
  const before = await readFile(input);
  const [shown] = answers(await s.send({ urls: [fileURL(input)], hideFloatingResult: false }));
  assert.ok(shown.kind === 'response');
  assert.equal(shown.response.path, input);
  assert.ok(before.equals(await readFile(input)));
  assert.deepEqual(await readdir(s.workdir.backups), [], 'no second placement and no second backup');
});

test('requests number %i files from the app\'s own counter, so they never reuse a number its watched folders gave out', async t => {
  if (!needTools(t, 'pngquant')) return;
  const shared = { value: 50 };
  const s = await setup(t, { counter: () => shared }, { lastAutoIncrementingNumber: 10 });
  const input = s.file('a.png');
  await graphic(120, 80).png({ compressionLevel: 0 }).toFile(input);
  const [first] = answers(await s.send({ urls: [fileURL(input)], output: s.file('out-%i') }));
  assert.ok(first.kind === 'response', JSON.stringify(first));
  assert.equal(path.basename(first.response.path), 'out-51.png');
  assert.equal(shared.value, 51);
  assert.equal(s.store.current.lastAutoIncrementingNumber, 51, 'the settings hear the shared value');
});

test('stopping a request also cancels the files no worker has taken yet', async t => {
  const started: string[] = [];
  const s = await setup(t, {
    withCard: (file, _kind, _request, signal) => new Promise((_, reject) => { started.push(path.basename(file)); signal.addEventListener('abort', () => reject(signal.reason)); }),
  });
  const urls: string[] = [];
  for (let i = 0; i < 7; i++) { const file = s.file(`f${i}.png`); await graphic(20, 20).png().toFile(file); urls.push(fileURL(file)); }
  const sent = s.send({ urls, hideFloatingResult: false });
  while (started.length < 4) await new Promise(resolve => setTimeout(resolve, 10));
  s.service.stop({ ids: urls, remove: false });
  const messages = answers(await sent);
  assert.deepEqual(started.sort(), ['f0.png', 'f1.png', 'f2.png', 'f3.png']);
  assert.equal(messages.filter(m => m.kind === 'error' && m.error.error === 'Stopped.').length, 7);
  assert.equal(messages.at(-1)?.kind, 'done');
});

test('stopping everything reaches every request, its running files and those still waiting', async t => {
  const started: string[] = [];
  const s = await setup(t, {
    withCard: (file, _kind, _request, signal) => new Promise((_, reject) => { started.push(path.basename(file)); signal.addEventListener('abort', () => reject(signal.reason)); }),
  });
  const urls: string[] = [];
  for (let i = 0; i < 6; i++) { const file = s.file(`f${i}.png`); await graphic(20, 20).png().toFile(file); urls.push(fileURL(file)); }
  const first = s.send({ urls: urls.slice(0, 5), hideFloatingResult: false }), second = s.send({ urls: urls.slice(5), hideFloatingResult: false });
  while (started.length < 5) await new Promise(resolve => setTimeout(resolve, 10));
  s.service.stopAll();
  const messages = [...answers(await first), ...answers(await second)];
  assert.equal(messages.filter(m => m.kind === 'error' && m.error.error === 'Stopped.').length, 6);
});

test('the same file twice in one request is worked on one pass after the other', async t => {
  let active = 0, most = 0;
  const s = await setup(t, { async withCard() { most = Math.max(most, ++active); await new Promise(resolve => setTimeout(resolve, 50)); active--; throw new Error('done with it'); } });
  const file = s.file('a.png');
  await graphic(20, 20).png().toFile(file);
  const messages = answers(await s.send({ urls: [fileURL(file), fileURL(file)], hideFloatingResult: false }));
  assert.equal(most, 1);
  assert.equal(messages.filter(m => m.kind === 'error').length, 2);
});

test('the same file under two spellings of its path is also worked on one pass after the other', async t => {
  let active = 0, most = 0;
  const s = await setup(t, { async withCard() { most = Math.max(most, ++active); await new Promise(resolve => setTimeout(resolve, 50)); active--; throw new Error('done with it'); } });
  const file = s.file('a.png');
  await graphic(20, 20).png().toFile(file);
  // The same file, spelled differently in the URL (on Windows, `A.PNG` for `a.png` is the same kind of difference).
  const other = fileURL(file).replace('/a.png', '/%61.png');
  assert.notEqual(other, fileURL(file));
  const messages = answers(await s.send({ urls: [fileURL(file), other], hideFloatingResult: false }));
  assert.equal(most, 1);
  assert.equal(messages.filter(m => m.kind === 'error').length, 2);
});

test('an agent\'s pipeline cannot replace a file by naming the same location text as the placement setting', async t => {
  if (!needTools(t, 'pngquant')) return;
  const s = await setup(t, {}, { mcpEnabled: true, optimisedImageBehaviour: 'sameFolder', sameFolderNameTemplateImage: '%f-optimised' });
  const input = s.file('a.png'), earlier = s.file('a-optimised.png');
  await graphic(60, 40).png().toFile(input);
  await writeFile(earlier, 'earlier result');
  const [explicit] = answers(await s.send({ urls: [fileURL(input)], origin: 'mcp', pipeline: 'optimise(location: "%f-optimised")' }));
  assert.ok(explicit.kind === 'error' && /already exists/.test(explicit.error.error), JSON.stringify(explicit));
  assert.equal(await readFile(earlier, 'utf8'), 'earlier result');
  s.store.current.savedPipelines = [{ id: 'HALF', name: 'Half', steps: parseSteps('downscale(factor: 0.5)'), skipOptimisation: false, hideResult: false }];
  const [saved] = answers(await s.send({ urls: [fileURL(input)], origin: 'mcp', pipeline: 'half' }));
  assert.ok(saved.kind === 'response', JSON.stringify(saved));
  assert.notEqual(await readFile(earlier, 'utf8'), 'earlier result', 'the placement setting itself may replace an earlier result');
});

test('only the user\'s own pipelines may open a program by path; an agent without script permission opens apps by name', async t => {
  if (!needTools(t, 'pngquant')) return;
  const seen: boolean[] = [];
  const saved = { id: 'OPEN', name: 'open', steps: parseSteps('openWith(app: "C:\\\\Tools\\\\viewer.exe")'), skipOptimisation: true, hideResult: false };
  // The headless effects the CLI uses, which resolve the app by the app's rule before starting anything.
  const s = await setup(t, { effects: options => { seen.push(options.allowExe); return shellEffects(options); } }, { savedPipelines: [saved], mcpEnabled: true });
  const input = s.file('a.png');
  await graphic(60, 40).png().toFile(input);
  const message = async (request: Partial<OptimisationRequest>) => {
    const [result] = answers(await s.send({ urls: [fileURL(input)], pipeline: 'open', ...request }));
    return result.kind === 'error' ? result.error.error : 'ok';
  };
  // The user's pipeline may name the program: it is looked up, and a program that is not there is not found (not refused).
  assert.match(await message({}), /not found/);
  assert.match(await message({ origin: 'mcp' }), /cannot open programs by path/);
  assert.deepEqual(seen, [true, false]);
  s.store.current = { ...s.store.current, mcpAllowScriptSteps: true };
  assert.match(await message({ origin: 'mcp' }), /not found/, 'with script steps allowed an agent is the user\'s hands');
  assert.deepEqual(seen, [true, false, true]);
});

test('PDFs are cropped to the request size ratio and compressed at its DPI', async t => {
  if (!needTools(t, 'gs')) return;
  const s = await setup(t);
  const input = s.file('scan.pdf');
  await writeFile(input, await photoPDF({ pages: 2 }));
  const [result] = answers(await s.send({ urls: [fileURL(input)], pdfDPI: 72, aggressiveOptimisation: true, size: { width: 100, height: 100, name: '', longEdge: false, smartCrop: false } }));
  assert.ok(result.kind === 'response', JSON.stringify(result));
  assert.equal(result.response.newDPI, 72);
  assert.ok(result.response.newBytes < result.response.oldBytes);
  const page = (await PDFDocument.load(await readFile(input))).getPage(0).getCropBox();
  assert.equal(Math.round(page.width), Math.round(page.height), 'the pages were cropped square');
});

test('plain requests become steps that end in one optimise left for placement', () => {
  const request: OptimisationRequest = { id: '1', urls: [], hideFloatingResult: true, copyToClipboard: false, aggressiveOptimisation: true, source: 'cli', changePlaybackSpeedFactor: 2, changePlaybackSpeedFrames: 'drop', removeAudio: true, downscaleFactor: 0.5, compression: { tier: 'smaller', factor: 70 } };
  assert.deepEqual(requestSteps(request, 'video'), [
    { downscale: { factor: 0.5, location: 'inPlace' } }, { changeSpeed: { factor: 2, frames: 'dropFrames' } }, { removeAudio: {} },
    { optimise: { encoder: 'aggressive', adaptive: false, location: 'temporaryFolder', compression: { tier: 'smaller', factor: 70 } } },
  ]);
  assert.deepEqual(requestSteps({ ...request, size: { width: 16, height: 9, name: '', longEdge: false, smartCrop: true, isAspectRatio: true } }, 'image')[0], { crop: { aspectRatio: '16:9', smartCrop: true, location: 'inPlace' } });
  assert.deepEqual(requestSteps({ ...request, size: { width: 100, height: 100, name: '', longEdge: false, smartCrop: false } }, 'audio').map(step => Object.keys(step)[0]), ['changeSpeed', 'optimise'], 'a crop does not lower an audio bitrate');
  assert.deepEqual(requestSteps({ ...request, audioBitrate: 128 }, 'audio').map(step => Object.keys(step)[0]), ['downscale', 'changeSpeed', 'lowerBitrate', 'optimise']);
  assert.deepEqual([factorText(0.5), factorText(0.25), factorText(0.125), cropSizeText({ width: 1919, height: 0, name: '', longEdge: false, smartCrop: false }), cropSizeText({ width: 1200, height: 630, name: '', longEdge: false, smartCrop: false })], ['0.5', '0.25', '0.125', '1920', '1200x630']);
});
