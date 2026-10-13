import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

// Runs the packaged clop.exe (spec step 25): headless with the app closed, then through the pipe with the app open.
// clop.exe starts the app's own Electron in Node mode with resources\cli.mjs, so this covers the stub, the bundled CLI,
// sharp inside app.asar and the bundled tools.
sharp.cache(false);
const unpacked = path.resolve('release/win-unpacked');
const clop = path.join(unpacked, 'cli', 'clop.exe');
const profile = await mkdtemp(path.join(os.tmpdir(), 'clop-cli-smoke-'));
const files = path.join(profile, 'files');
await mkdir(files);
const env = { ...process.env, CLOP_USER_DATA: profile };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const image = async name => {
  const file = path.join(files, name);
  await sharp({ create: { width: 640, height: 480, channels: 3, background: '#3a7bd5' } }).composite([{ input: Buffer.from('<svg width="640" height="480"><circle cx="320" cy="240" r="200" fill="#f5a623"/></svg>') }]).png({ compressionLevel: 0 }).toFile(file);
  return file;
};
const run = args => promisify(execFile)(clop, args, { env, timeout: 120_000 });
let app;
try {
  const headless = await image('headless.png'), before = (await stat(headless)).size;
  const { stdout } = await run(['optimise', headless, '--json']);
  const result = JSON.parse(stdout);
  assert.equal(result.done.length, 1, stdout);
  assert.ok(result.done[0].newBytes < before, stdout);
  assert.equal((await stat(headless)).size, result.done[0].newBytes);
  const failed = await run(['crop', headless]).catch(error => error);
  assert.equal(failed.code, 64, 'a usage error exits 64 through clop.exe');
  console.log('clop.exe optimised a file with the app closed');

  // --async without the app hands the work to a detached copy of the CLI, which must outlive clop.exe.
  const queued = await image('queued.png'), queuedSize = (await stat(queued)).size;
  await run(['optimise', '--async', queued]);
  const asyncDeadline = Date.now() + 60_000;
  while ((await stat(queued)).size === queuedSize && Date.now() < asyncDeadline) await pause(500);
  assert.ok((await stat(queued)).size < queuedSize, 'the detached CLI finished the file after clop.exe exited');
  console.log('clop.exe --async finished in the background with the app closed');

  // The app publishes its pipe in this profile; the debug log records the request it served.
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ persistDebugLogs: true }));
  app = spawn(path.join(unpacked, 'Clop for Windows.exe'), [`--user-data-dir=${profile}`], { stdio: 'ignore' });
  const deadline = Date.now() + 30_000;
  while (!(await stat(path.join(profile, 'ipc.json')).catch(() => undefined)) && Date.now() < deadline) await pause(250);
  const shown = await image('shown.png');
  const viaApp = JSON.parse((await run(['optimise', shown, '--gui', '--json'])).stdout);
  assert.equal(viaApp.done.length, 1, JSON.stringify(viaApp));
  assert.match(await readFile(path.join(profile, 'logs', 'clop.log'), 'utf8'), /CLI request: optimise/);
  const settings = JSON.parse((await run(['settings', 'get', 'persistDebugLogs', '--json'])).stdout);
  assert.equal(settings.settings[0].value, 'true');
  console.log('clop.exe optimised a file through the running app');
} finally {
  app?.kill();
  await pause(1000);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
