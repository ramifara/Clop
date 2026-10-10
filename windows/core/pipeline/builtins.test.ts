import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveHome } from '../template';
import { BUILTIN_PIPELINES_VERSION, BUILTIN_PIPELINE_DEFS, builtinPipeline, seedBuiltinPipelines } from './builtins';
import { decodePipeline, decodePipelines, isReadable, pipelineToJSON, storedToJSON, Unreadable, type Stored } from './codec';
import { isBuiltin, type Pipeline } from './model';
import { formatSteps, parseSteps } from './parser';

const macStore = JSON.parse(readFileSync(new URL('../../fixtures/pipelines/macos-store.json', import.meta.url), 'utf8')) as { savedPipelines: string[] };
const ids = (entries: Stored<Pipeline>[]) => entries.map(entry => isReadable(entry) ? entry.id : entry.raw);
const user: Pipeline = { id: '1B2C3D4E-0000-4000-8000-000000000000', steps: [{ stripExif: {} }], name: 'Mine', skipOptimisation: false, hideResult: false };

test('the eleven built-ins are the macOS ones, seeded exactly as macOS stores them', () => {
  assert.equal(BUILTIN_PIPELINE_DEFS.length, 11);
  assert.deepEqual(BUILTIN_PIPELINE_DEFS.map(def => def.name), ['to WebP', 'Sort screenshots', '0.5×', 'Watermark', '1080p', 'to GIF', '2× silent', '0.5×', 'Watermark', 'as images', 'to MP3']);
  assert.equal(new Set(BUILTIN_PIPELINE_DEFS.map(def => def.id)).size, 11);
  assert.deepEqual(BUILTIN_PIPELINE_DEFS.map(builtinPipeline).map(pipelineToJSON), macStore.savedPipelines.slice(0, 11));
  for (const def of BUILTIN_PIPELINE_DEFS) {
    assert.ok(isBuiltin(builtinPipeline(def)) && def.version <= BUILTIN_PIPELINES_VERSION, def.id);
    const steps = parseSteps(def.rawText, { fileType: def.fileType });
    assert.deepEqual(parseSteps(formatSteps(steps), { fileType: def.fileType }), steps, def.rawText);
    assert.deepEqual(decodePipeline(pipelineToJSON(builtinPipeline(def))), builtinPipeline(def));
  }
  assert.equal(isBuiltin(user), false);
});

test('built-in paths land in the Windows user profile', () => {
  const sort = builtinPipeline(BUILTIN_PIPELINE_DEFS[1]);
  const move = sort.steps.find(step => 'move' in step) as { move: { to: string } };
  assert.equal(resolveHome(move.move.to, 'C:\\Users\\Rami', 'win32'), 'C:\\Users\\Rami\\Pictures\\Screenshots\\%y\\%m\\');
  assert.equal(resolveHome(move.move.to, '/home/rami', 'linux'), '/home/rami/Pictures/Screenshots/%y/%m/');
});

test('built-ins are seeded once per version and deletions stick', () => {
  const first = seedBuiltinPipelines([user], 0)!;
  assert.equal(first.builtinPipelinesSeededVersion, BUILTIN_PIPELINES_VERSION);
  assert.deepEqual(ids(first.savedPipelines), [user.id, ...BUILTIN_PIPELINE_DEFS.map(def => def.id)]);
  assert.equal(seedBuiltinPipelines(first.savedPipelines, first.builtinPipelinesSeededVersion), undefined);

  // Seeded at version 1, one deleted and one edited before icons existed: the deleted one stays gone, the edited one keeps
  // its edits and only gains the missing icon and details.
  const edited: Pipeline = { ...builtinPipeline(BUILTIN_PIPELINE_DEFS[0]), rawText: 'convert(to: avif)', steps: parseSteps('convert(to: avif)'), icon: undefined, details: undefined };
  const kept = BUILTIN_PIPELINE_DEFS.slice(2).map(builtinPipeline);
  const upgraded = seedBuiltinPipelines([edited, ...kept], 1)!;
  assert.deepEqual(ids(upgraded.savedPipelines), [edited.id, ...kept.map(p => p.id)]);
  assert.deepEqual(upgraded.savedPipelines[0], { ...edited, icon: 'photo', details: 'Convert images to the compact WebP format' });
});

test('seeding keeps entries it cannot read, and does not add a built-in again when its stored copy is unreadable', () => {
  // A built-in a newer macOS changed into a step this version does not know, kept as the Defaults string, and an unknown object.
  const newerWebP = JSON.stringify({ id: 'builtin-image-webp', steps: [{ teleport: {} }], skipOptimisation: true, hideResult: false });
  const stored = decodePipelines([newerWebP, { id: 'X', steps: [{ fly: {} }] }])!;
  assert.ok(stored.every(entry => entry instanceof Unreadable));
  const seeded = seedBuiltinPipelines(stored, 0)!;
  assert.deepEqual(seeded.savedPipelines.slice(0, 2), stored, 'kept exactly as they came');
  assert.equal(storedToJSON(seeded.savedPipelines[0], pipelineToJSON), newerWebP);
  assert.deepEqual(ids(seeded.savedPipelines.slice(2)), BUILTIN_PIPELINE_DEFS.slice(1).map(def => def.id));
});
