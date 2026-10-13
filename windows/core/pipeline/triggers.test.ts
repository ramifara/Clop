import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../settings/schema';
import { decodePipelines, pipelineToJSON } from './codec';
import { referenceTo, type Pipeline } from './model';
import { parseSteps } from './parser';
import { pipelinesFor, pipelinesSkipOptimisation, runPipelines, skipsPreOptimisation } from './triggers';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { graphic } from '../media/image.fixtures';
import { pipelineWorkspace } from './executor.fixtures';

const pipeline = (id: string, text: string): Pipeline => ({ id, steps: parseSteps(text), rawText: text, skipOptimisation: false, hideResult: false });

test('pipelinesFor finds the pipelines attached to a folder or the clipboard, references resolved', () => {
  const saved = pipeline('SAVED', 'convert(to: webp)'), clipboard = pipeline('CLIP', 'downscale(factor: 0.5)');
  const settings = {
    ...defaultSettings(),
    savedPipelines: [saved],
    pipelinesToRunOnImage: { clipboard: [clipboard], '~/Downloads': [referenceTo(saved)], '/srv/Shots/': decodePipelines([pipelineToJSON(clipboard), { id: 'NEWER', steps: [{ teleport: {} }] }])! },
    pipelinesToRunOnVideo: { clipboard: [pipeline('VID', 'removeAudio')] },
  };
  assert.deepEqual(pipelinesFor('image', 'clipboard', settings), [clipboard]);
  assert.deepEqual(pipelinesFor('video', 'clipboard', settings).map(p => p.id), ['VID']);
  assert.deepEqual(pipelinesFor('pdf', 'clipboard', settings), []);
  assert.deepEqual(pipelinesFor('image', '/home/rami/Downloads', settings, { home: '/home/rami', platform: 'linux' }), [saved], 'a portable key matches the full path');
  assert.deepEqual(pipelinesFor('image', '/srv/Shots', settings, { platform: 'linux' }), [clipboard], 'entries this version cannot read are left out');
  assert.deepEqual(pipelinesFor('image', '/srv/shots', settings, { platform: 'linux' }), [], 'POSIX paths are case-sensitive');

  // A reference to a saved pipeline this version cannot read is skipped, not run as an empty pipeline.
  const newer = decodePipelines([JSON.stringify({ id: 'NEWER-SAVED', steps: [{ teleport: {} }] })])!;
  const withNewer = { ...settings, savedPipelines: [saved, ...newer], pipelinesToRunOnImage: { clipboard: [referenceTo({ ...saved, id: 'NEWER-SAVED' }), referenceTo(saved)] } };
  assert.deepEqual(pipelinesFor('image', 'clipboard', withNewer), [saved]);
  const gone = { ...settings, pipelinesToRunOnImage: { clipboard: [referenceTo({ ...saved, id: 'DELETED' }), clipboard] } };
  assert.deepEqual(pipelinesFor('image', 'clipboard', gone), [clipboard], 'a reference to a deleted saved pipeline runs nothing');
});

test('on Windows a folder matches ignoring case and slash direction', () => {
  const shots = pipeline('SHOTS', 'optimise');
  const settings = { ...defaultSettings(), pipelinesToRunOnImage: { 'C:/Users/Rami/Pictures/Screenshots': [shots], '~/Desktop': [shots] } };
  const windows = { home: 'C:\\Users\\Rami', platform: 'win32' as const };
  assert.deepEqual(pipelinesFor('image', 'c:\\users\\rami\\pictures\\screenshots\\', settings, windows), [shots]);
  assert.deepEqual(pipelinesFor('image', 'C:\\Users\\Rami\\Desktop', settings, windows), [shots]);
  assert.deepEqual(pipelinesFor('image', 'C:\\Users\\Rami\\Documents', settings, windows), []);
});

test('pipelines that start by re-encoding, or say so, skip the plain optimisation', () => {
  assert.equal(skipsPreOptimisation(pipeline('A', 'if(types: png) -> convert(to: webp)')), true, 'filters do not count');
  assert.equal(skipsPreOptimisation(pipeline('B', 'crop(width: 100)')), true);
  assert.equal(skipsPreOptimisation(pipeline('C', 'optimise -> convert(to: webp)')), false);
  assert.equal(skipsPreOptimisation({ ...pipeline('D', 'copyToClipboard'), skipOptimisation: true }), true);
  assert.equal(pipelinesSkipOptimisation([pipeline('A', 'downscale(factor: 0.5)'), pipeline('C', 'optimise')]), false, 'every one has to');
  assert.equal(pipelinesSkipOptimisation([]), false);
});

test('runPipelines runs each pipeline on the same file, reports failures and carries on', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png');
  await graphic(40, 30).png().toFile(input);
  const env = { settings: w.settings, workdir: w.workdir, counter: w.counter, marker: w.marker };
  const outcome = await runPipelines([
    { ...pipeline('ONE', 'copy(to: "%P/a/")'), name: 'First' }, { ...pipeline('TWO', 'copyLinkForSending'), name: 'Second' },
    { ...pipeline('THREE', 'if(types: jpeg) -> copy(to: "%P/b/")') }, { ...pipeline('FOUR', 'copy(to: "%P/c/")'), hideResult: true },
  ], input, { fileType: 'image', env, effects: w.effects, allowScripts: true });
  assert.deepEqual([outcome.anyRan, outcome.hidden, outcome.file], [true, true, path.join(w.files, 'c', 'in.png')]);
  assert.deepEqual(outcome.warnings, ['Second: Step 1, copyLinkForSending, failed: Share links need an upload target in Settings.']);
  assert.deepEqual((await readdir(w.files)).sort(), ['a', 'c', 'in.png'], 'each started from in.png; the filtered one did nothing');
});

test('a fork keeps a copy when a later pipeline works on the same file', async t => {
  const w = await pipelineWorkspace(t, 'pngquant'); if (!w) return;
  const input = w.file('in.png');
  await graphic(200, 150).png({ compressionLevel: 0 }).toFile(input);
  const before = await readFile(input);
  const env = { settings: w.settings, workdir: w.workdir, counter: w.counter, marker: w.marker };
  const outcome = await runPipelines([pipeline('ONE', 'fork'), pipeline('TWO', 'optimise')], input, { fileType: 'image', env, effects: w.effects, allowScripts: true });
  assert.equal(outcome.forks.length, 1);
  assert.notEqual(outcome.forks[0], input, 'the fork is its own file');
  assert.deepEqual(await readFile(outcome.forks[0]), before, 'and holds the file as the first pipeline left it');
  // The last pipeline's fork can still be the file itself.
  const alone = await runPipelines([pipeline('ONE', 'fork')], input, { fileType: 'image', env, effects: w.effects, allowScripts: true });
  assert.deepEqual(alone.forks, [input]);
});
