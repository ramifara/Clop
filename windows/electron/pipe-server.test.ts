import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../cli/main';
import type { IO } from '../cli/results';
import { appPipe, AppNotResponding, AppNotRunning, ForgedServer, sendMessage } from '../core/ipc/client';
import { helloProof, newPipeKey, newPipePath, pipeInfoFile, type ClientMessage, type ServerMessage } from '../core/ipc/protocol';
import { ClopService } from '../core/ipc/service';
import { OptimisedMarker } from '../core/marker';
import { graphic } from '../core/media/image.fixtures';
import { FakeEffects } from '../core/pipeline/executor.fixtures';
import { SettingsStore } from '../core/settings/store';
import { needTools } from '../core/testing';
import { Workdir } from '../core/workdir';
import { publishPipe, startPipeServer } from './pipe-server';

/** An app stand-in: the real service behind the real pipe server, published where the CLI looks for it. */
async function app(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const userData = path.join(dir, 'data');
  const store = new SettingsStore(path.join(userData, 'settings.json'), { home: dir, desktop: dir, userData });
  await store.load();
  const workdir = await new Workdir(path.join(userData, 'work')).ensure();
  const service = new ClopService({ store, workdir, effects: new FakeEffects(), marker: new OptimisedMarker(path.join(userData, 'optimised.json')) });
  const received: ClientMessage['kind'][] = [];
  const server = await startPipeServer(newPipePath(), (message, emit) => { received.push(message.kind); return service.handle(message, emit); });
  const withdraw = await publishPipe(userData, server);
  t.after(async () => { withdraw(); await server.close(); });
  const out: string[] = [], err: string[] = [];
  const io: IO = { out: text => { out.push(text); }, err: text => { err.push(text); }, errTTY: false };
  const cli = (...argv: string[]) => main(argv, { io, cwd: dir, options: { userData, home: dir }, env: {}, colours: false });
  return { dir, userData, store, server, received, out, err, cli };
}

test('the CLI finds the running app and round-trips an optimise request over the pipe', async t => {
  if (!needTools(t, 'pngquant')) return;
  const a = await app(t);
  assert.deepEqual(await appPipe(a.userData), { pipe: a.server.path, key: a.server.key });
  const input = path.join(a.dir, 'shot.png');
  await graphic(300, 200).png({ compressionLevel: 0 }).toFile(input);
  const before = (await stat(input)).size;
  assert.equal(await a.cli('optimise', 'shot.png', '--json'), 0, a.err.join(''));
  assert.deepEqual(a.received, ['optimise']);
  const result = JSON.parse(a.out.join(''));
  assert.equal(result.done[0].path, input);
  assert.equal(result.done[0].oldBytes, before);
  assert.ok(result.done[0].newBytes < before);
  assert.deepEqual(result.failed, []);

  // --async hands the request over and returns; the app finishes it after the CLI is gone.
  const queued = path.join(a.dir, 'queued.png');
  await graphic(300, 200, { seed: 9 }).png({ compressionLevel: 0 }).toFile(queued);
  const size = (await stat(queued)).size;
  assert.equal(await a.cli('optimise', '--async', 'queued.png'), 0, a.err.join(''));
  assert.match(a.err.join(''), /Queued 1 items for optimisation\nUse the `--gui` flag to see progress/);
  for (let i = 0; i < 100 && (await stat(queued)).size === size; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok((await stat(queued)).size < size);
});

test('settings go through the app, which applies and saves them', async t => {
  const a = await app(t);
  assert.equal(await a.cli('settings', 'set', 'stripMetadata', 'false'), 0, a.err.join(''));
  assert.equal(a.store.get('stripMetadata'), false);
  assert.equal(JSON.parse(await readFile(path.join(a.userData, 'settings.json'), 'utf8')).stripMetadata, false);
  assert.equal(await a.cli('pipeline', 'add', 'Tiny', 'downscale(factor: 0.5)'), 0, a.err.join(''));
  assert.equal(a.store.get('savedPipelines').length, 1);
  assert.deepEqual(a.received, ['settings', 'settings', 'settings']);
});

test('a connection must greet first, a malformed request gets a failed answer, and nothing listening means no app', async t => {
  const a = await app(t);
  const exchange = (...lines: string[]) => new Promise<unknown[]>((resolve, reject) => {
    const chunks: string[] = [];
    const socket = net.connect(a.server.path, () => { for (const line of lines) socket.write(`${line}\n`); });
    socket.on('data', chunk => chunks.push(chunk.toString())).on('end', () => resolve(chunks.join('').trim().split('\n').map(line => JSON.parse(line)))).on('error', reject);
  });
  assert.deepEqual(await exchange('{"kind":"settings","request":{"action":"read"}}'), [{ kind: 'failed', error: 'The connection must start with a greeting.' }]);
  const [hello, failed] = await exchange(JSON.stringify({ hello: 'n'.repeat(32) }), '{"kind":"exec","request":{}}');
  assert.deepEqual(hello, { hello: helloProof(a.server.key, 'n'.repeat(32)) });
  assert.deepEqual(failed, { kind: 'failed', error: 'The message kind must be optimise, stop or settings.' });
  await assert.rejects(sendMessage({ pipe: newPipePath(), key: a.server.key }, { kind: 'settings', request: { action: 'read' } }), AppNotRunning);
  const empty: ServerMessage[] = [];
  await sendMessage({ pipe: a.server.path, key: a.server.key }, { kind: 'optimise', request: { id: '1', urls: [], hideFloatingResult: true, copyToClipboard: false, aggressiveOptimisation: false, source: 'cli' } }, message => empty.push(message));
  assert.deepEqual(empty, [{ kind: 'done' }], 'the connection ends after the last answer');
});

test('a pipe that cannot prove it is the app gets no request, and the CLI runs headless', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-forged-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A squatter on the published name: it answers the greeting with a guess and records everything it is sent.
  const heard: string[] = [];
  const forged = net.createServer(socket => socket.on('data', chunk => {
    heard.push(chunk.toString());
    socket.write(`${JSON.stringify({ hello: helloProof(Buffer.alloc(32).toString('base64'), 'guess') })}\n`);
  }));
  const pipe = newPipePath();
  await new Promise<void>(resolve => forged.listen(pipe, resolve));
  t.after(() => new Promise<void>(resolve => forged.close(() => resolve())));
  await writeFile(pipeInfoFile(dir), JSON.stringify({ pipe, pid: 1, key: newPipeKey() }));
  await assert.rejects(sendMessage({ pipe, key: newPipeKey() }, { kind: 'settings', request: { action: 'read' } }), ForgedServer);
  const out: string[] = [], err: string[] = [];
  const code = await main(['settings', 'set', 'stripMetadata', 'false'], { io: { out: text => { out.push(text); }, err: text => { err.push(text); }, errTTY: false }, cwd: dir, options: { userData: dir, home: dir }, env: {}, colours: false });
  assert.equal(code, 0, err.join(''));
  assert.match(err.join(''), /answered by something that is not Clop, so nothing was sent to it\. Running here instead\./);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).stripMetadata, false, 'the change went to the settings file');
  assert.ok(heard.every(text => !text.includes('stripMetadata')), 'the squatter only ever saw greetings');
});

test('a held pipe that does not answer is a busy app: the CLI reads settings here but does not change them', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-silent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // One listener never answers, one hangs up on every greeting: neither is a wrong proof.
  const sockets = new Set<net.Socket>();
  const silent = net.createServer(socket => { sockets.add(socket); }), hangUp = net.createServer(socket => socket.on('data', () => socket.destroy()));
  const silentPipe = newPipePath(), hangUpPipe = newPipePath();
  await new Promise<void>(resolve => silent.listen(silentPipe, resolve));
  await new Promise<void>(resolve => hangUp.listen(hangUpPipe, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([silent, hangUp].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });
  const key = newPipeKey(), read: ClientMessage = { kind: 'settings', request: { action: 'read' } };
  await assert.rejects(sendMessage({ pipe: silentPipe, key }, read, undefined, { connectTimeoutMs: 100 }), AppNotResponding);
  await assert.rejects(sendMessage({ pipe: hangUpPipe, key }, read), AppNotResponding);

  await writeFile(pipeInfoFile(dir), JSON.stringify({ pipe: hangUpPipe, pid: 1, key }));
  const out: string[] = [], err: string[] = [];
  const cli = (...argv: string[]) => main(argv, { io: { out: text => { out.push(text); }, err: text => { err.push(text); }, errTTY: false }, cwd: dir, options: { userData: dir, home: dir }, env: {}, colours: false });
  assert.notEqual(await cli('settings', 'set', 'stripMetadata', 'false'), 0);
  assert.match(err.join(''), /Clop is running but did not answer, so nothing was sent to it\. Running here instead\./);
  assert.match(err.join(''), /Clop is running but not answering, so the settings were not changed/);
  await assert.rejects(readFile(path.join(dir, 'settings.json')), { code: 'ENOENT' }, 'nothing was written behind the app');
  assert.equal(await cli('settings', 'get', 'pdfDPI', '--json'), 0, err.join(''));
  assert.equal(JSON.parse(out.join('')).settings[0].value, '0');
});

test('a CLI with no app published runs headless', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-headless-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out: string[] = [];
  const code = await main(['settings', 'get', 'pdfDPI', '--json'], { io: { out: text => { out.push(text); }, err: () => {}, errTTY: false }, cwd: dir, options: { userData: dir, home: dir }, env: {}, colours: false });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.join('')).settings[0].value, '0');
});
