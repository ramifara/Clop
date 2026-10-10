import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../settings/schema';
import { decodePipelines, pipelineToJSON } from './codec';
import { referenceTo, type Pipeline } from './model';
import { parseSteps } from './parser';
import { pipelinesFor } from './triggers';

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
});

test('on Windows a folder matches ignoring case and slash direction', () => {
  const shots = pipeline('SHOTS', 'optimise');
  const settings = { ...defaultSettings(), pipelinesToRunOnImage: { 'C:/Users/Rami/Pictures/Screenshots': [shots], '~/Desktop': [shots] } };
  const windows = { home: 'C:\\Users\\Rami', platform: 'win32' as const };
  assert.deepEqual(pipelinesFor('image', 'c:\\users\\rami\\pictures\\screenshots\\', settings, windows), [shots]);
  assert.deepEqual(pipelinesFor('image', 'C:\\Users\\Rami\\Desktop', settings, windows), [shots]);
  assert.deepEqual(pipelinesFor('image', 'C:\\Users\\Rami\\Documents', settings, windows), []);
});
