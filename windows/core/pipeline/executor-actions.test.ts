import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { graphic } from '../media/image.fixtures';
import { clip } from '../media/video.fixtures';
import { pipelineWorkspace } from './executor.fixtures';

test('clipboard, app and share steps go through the app', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('shot.png');
  await graphic(40, 30).png().toFile(input);
  await w.run(`copyToClipboard -> copyToClipboard(format: markdown, relativeTo: "%P") -> copyToClipboard(format: imageData) -> openWith(app: "Paint") -> shelveWith(app: yoink) -> uploadWith(app: dropshare)`, input);
  assert.deepEqual(w.effects.clipboard, [{ text: input }, { text: '[shot](/shot.png)' }, { image: input }]);
  assert.deepEqual(w.effects.opened, [[input, 'Paint'], [input, 'yoink'], [input, 'dropshare']]);
  assert.equal(await w.marker.isOptimised(input), true);
  await assert.rejects(w.run('openWith(app: "Missing")', input), /Step 1, openWith\(app: Missing\), failed: App 'Missing' not found/);
  await assert.rejects(w.run('copyLinkForSending', input), /Share links need an upload target in Settings/);
});

test('fork hands back the result so far, copied when a later step would change it', async t => {
  const w = await pipelineWorkspace(t, 'pngquant'); if (!w) return;
  const input = w.file('logo.png');
  await graphic(200, 100).png().toFile(input);
  const untouched = await w.run('fork', input);
  assert.deepEqual(untouched.forks, [input]);
  const before = await readFile(input);
  const copied = await w.run('fork -> downscale(factor: 0.5)', input);
  assert.ok(w.workdir.owns(copied.forks[0]));
  assert.deepEqual(await readFile(copied.forks[0]), before, 'the fork keeps the file as it was at the fork');
  const saved = await w.run('fork(location: "%f-copy")', input);
  assert.deepEqual(saved.forks, [w.file('logo-copy.png')]);
});

test('progress is reported per step, and cancelling stops before the next step', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png');
  await graphic(40, 30).png().toFile(input);
  const events: string[] = [];
  await w.run('copy(to: "%P/a/") -> copy(to: "%P/b/")', input, { onProgress: ({ step, steps, text, fraction }) => events.push(`${step}/${steps} ${text} ${fraction}`) });
  assert.deepEqual(events, ['0/2 copy(to: "%P/a/") 0', '0/2 copy(to: "%P/a/") 1', '1/2 copy(to: "%P/b/") 0', '1/2 copy(to: "%P/b/") 1']);

  const controller = new AbortController();
  await assert.rejects(w.run('copy(to: "%P/c/") -> copy(to: "%P/d/")', input, { signal: controller.signal, onProgress: ({ step, fraction }) => { if (step === 0 && fraction === 1) controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual((await readdir(w.files)).sort(), ['a', 'b', 'c', 'in.png']);
});

test('cancelling an encode stops it and leaves no temporary files', async t => {
  const w = await pipelineWorkspace(t, 'ffmpeg', 'ffprobe'); if (!w) return;
  const input = await clip(w.file('long.mp4'), { width: 640, height: 480, seconds: 6 });
  const before = await readFile(input);
  const controller = new AbortController();
  const running = w.run('optimise(encoder: slowHighQuality)', input, { signal: controller.signal, onProgress: () => setTimeout(() => controller.abort(), 50) });
  await assert.rejects(running, { name: 'AbortError' });
  assert.deepEqual(await readFile(input), before);
  assert.deepEqual(await w.temp(), []);
});
