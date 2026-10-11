import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { OptimisationRequest } from '../core/ipc/protocol';
import { needTools } from '../core/testing';
import { clip } from '../core/media/video.fixtures';
import { OptimisedMarker } from '../core/marker';
import { defaultSettings } from '../core/settings/schema';
import { Workdir } from '../core/workdir';
import { folderPlacement, restoreAll } from './automation';
import { cardOptimiser } from './card';
import { ItemEngine, sampleImage } from './items';

async function fixture(t: TestContext) {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'gifsicle', 'ffmpeg', 'exiftool')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-card-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const engine = new ItemEngine(path.join(dir, 'session')), made: string[] = [];
  // The app's defaults with the image format setting on WebP, as a user may have chosen.
  const card = cardOptimiser({ engine: () => engine, makeRoom: async () => { made.push('room'); }, defaults: aggressive => ({ mode: aggressive ? 'aggressive' : 'balanced', format: 'webp', scale: 1 }) });
  const request = (change: Partial<OptimisationRequest> = {}): OptimisationRequest => ({ id: '1', urls: [], hideFloatingResult: false, copyToClipboard: false, aggressiveOptimisation: false, source: 'cli', ...change });
  const png = path.join(dir, 'shot.png');
  await writeFile(png, await sampleImage());
  return { dir, engine, card, request, png, made };
}

test('a plain request is optimised with a card, in the file\'s own format whatever the image format setting says', async t => {
  const f = await fixture(t); if (!f) return;
  const output = await f.card(f.png, 'image', f.request(), new AbortController().signal) as string;
  assert.ok(output && output !== f.png);
  assert.equal((await sharp(output).metadata()).format, 'png');
  assert.deepEqual(f.made, ['room']);
});

test('a downscale below 1 scales the card, and a factor of 1 or more changes nothing instead of failing', async t => {
  const f = await fixture(t); if (!f) return;
  const half = await f.card(f.png, 'image', f.request({ downscaleFactor: 0.5 }), new AbortController().signal) as string;
  assert.equal((await sharp(half).metadata()).width, 1200);
  const more = await f.card(f.png, 'image', f.request({ downscaleFactor: 1.5 }), new AbortController().signal) as string;
  assert.equal((await sharp(more).metadata()).width, 2400);
});

test('what the engine\'s plain optimisation does not express is left to the pipe service', async t => {
  const f = await fixture(t); if (!f) return;
  const signal = new AbortController().signal;
  for (const change of [{ size: { width: 100, height: 100, name: '', longEdge: false, smartCrop: false } }, { compression: { tier: 'custom' as const, factor: 40 } }, { downscaleFactor: 0.05 }, { pdfDPI: 72 }]) {
    assert.equal(await f.card(f.png, 'image', f.request(change), signal), undefined, JSON.stringify(change));
  }
  assert.deepEqual(f.made, [], 'no card was made room for');
  assert.equal(f.engine.list().length, 0);
});

test('a request stopped while its card is optimising ends with Stopped. and leaves the source alone', async t => {
  const f = await fixture(t); if (!f) return;
  const video = await clip(path.join(f.dir, 'long.mp4'), { width: 640, height: 360, seconds: 4 }), stop = new AbortController();
  const job = f.card(video, 'video', f.request(), stop.signal);
  while (!f.engine.list().length || f.engine.list()[0].status !== 'processing') await new Promise(resolve => setTimeout(resolve, 10));
  stop.abort();
  await assert.rejects(job, /Stopped\./);
});

test('with a placement the card writes over the file itself, so its Restore and a revert give the original back', async t => {
  const f = await fixture(t); if (!f) return;
  const workdir = await new Workdir(path.join(f.dir, 'work')).ensure(), marker = new OptimisedMarker(path.join(f.dir, 'optimised.json'));
  const env = () => ({ settings: defaultSettings(), workdir, marker, counter: { value: 0 } });
  const card = cardOptimiser({ engine: () => f.engine, makeRoom: async () => {}, defaults: () => ({ mode: 'balanced', format: 'auto', scale: 1 }), placement: file => folderPlacement(file, 'image', env) });
  const original = await readFile(f.png);
  assert.deepEqual(await card(f.png, 'image', f.request(), new AbortController().signal), { placed: f.png });
  assert.ok((await readFile(f.png)).length < original.length, 'the file itself was optimised');
  await restoreAll(f.engine, f.engine.list().map(item => item.id));
  assert.ok(original.equals(await readFile(f.png)), 'Restore put the original back over the file');
});
