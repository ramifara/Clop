import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../cli/main';
import type { IO } from '../cli/results';
import { appPipe, AppNotRunning, sendMessage } from '../core/ipc/client';
import { newPipePath, type ClientMessage, type ServerMessage } from '../core/ipc/protocol';
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
  const withdraw = await publishPipe(userData, server.path);
  t.after(async () => { withdraw(); await server.close(); });
  const out: string[] = [], err: string[] = [];
  const io: IO = { out: text => { out.push(text); }, err: text => { err.push(text); }, errTTY: false };
  const cli = (...argv: string[]) => main(argv, { io, cwd: dir, options: { userData, home: dir }, env: {}, colours: false });
  return { dir, userData, store, server, received, out, err, cli };
}

test('the CLI finds the running app and round-trips an optimise request over the pipe', async t => {
  if (!needTools(t, 'pngquant')) return;
  const a = await app(t);
  assert.equal(await appPipe(a.userData), a.server.path);
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

test('a malformed request gets a failed answer, and nothing listening means the app is not running', async t => {
  const a = await app(t);
  const lines: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(a.server.path, () => socket.write('{"kind":"exec","request":{}}\n'));
    socket.on('data', chunk => lines.push(chunk.toString())).on('end', resolve).on('error', reject);
  });
  assert.deepEqual(lines.join('').trim().split('\n').map(line => JSON.parse(line)), [{ kind: 'failed', error: 'The message kind must be optimise, stop or settings.' }]);
  const answers: ServerMessage[] = [];
  await assert.rejects(sendMessage(newPipePath(), { kind: 'settings', request: { action: 'read' } }, message => answers.push(message)), AppNotRunning);
  const empty: ServerMessage[] = [];
  await sendMessage(a.server.path, { kind: 'optimise', request: { id: '1', urls: [], hideFloatingResult: true, copyToClipboard: false, aggressiveOptimisation: false, source: 'cli' } }, message => empty.push(message));
  assert.deepEqual(empty, [{ kind: 'done' }], 'the connection ends after the last answer');
});

test('a CLI with no app published runs headless', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-headless-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out: string[] = [];
  const code = await main(['settings', 'get', 'pdfDPI', '--json'], { io: { out: text => { out.push(text); }, err: () => {}, errTTY: false }, cwd: dir, options: { userData: dir, home: dir }, env: {}, colours: false });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.join('')).settings[0].value, '0');
});
