import assert from 'node:assert/strict';
import { PDFDocument } from '@cantoo/pdf-lib';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import { OptimisedMarker } from '../marker';
import { graphic, photo } from '../media/image.fixtures';
import { photoPDF } from '../media/pdf.fixtures';
import { FakeEffects } from '../pipeline/executor.fixtures';
import { parseSteps } from '../pipeline/parser';
import { defaultSettings, type ClopSettings } from '../settings/schema';
import { needTools } from '../testing';
import { shellEffects } from '../shell-effects';
import { Workdir } from '../workdir';
import { fileURL, type OptimisationRequest, type ServerMessage } from './protocol';
import { ClopService, cropSizeText, factorText, requestSteps, type ServiceDeps } from './service';

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
  assert.match((review[0] as { error: { error: string } }).error.error, /batch optimiser window/);
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
