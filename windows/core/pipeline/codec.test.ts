import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultSettings, parseSettings } from '../settings/schema';
import { decodePipeline, decodePipelineSources, decodePipelines, decodePresetZone, decodeStep, encodePipeline, pipelineToJSON, presetZoneToJSON } from './codec';
import { STEP_KINDS, stepKind, type Pipeline } from './model';
import { PipelineError, formatSteps, parseSteps } from './parser';

const fixtureFile = new URL('../../fixtures/pipelines/macos-store.json', import.meta.url);
const fixtureText = readFileSync(fixtureFile, 'utf8');
const store = JSON.parse(fixtureText) as { savedPipelines: string[]; presetZones: string[] } & Record<`pipelinesToRunOn${string}`, Record<string, string[]>>;
const SOURCE_KEYS = ['pipelinesToRunOnImage', 'pipelinesToRunOnVideo', 'pipelinesToRunOnPdf', 'pipelinesToRunOnAudio'] as const;
const allPipelineStrings = [...store.savedPipelines, ...SOURCE_KEYS.flatMap(key => Object.values(store[key]).flat())];

test('the macOS store fixture covers every step case', () => {
  const kinds = new Set(allPipelineStrings.flatMap(text => decodePipeline(text).steps.map(stepKind)));
  assert.deepEqual(STEP_KINDS.filter(kind => !kinds.has(kind)), []);
});

test('every pipeline in a macOS store re-serialises byte for byte', () => {
  for (const text of allPipelineStrings) assert.equal(pipelineToJSON(decodePipeline(text)), text);
  for (const text of store.presetZones) assert.equal(presetZoneToJSON(decodePresetZone(text)), text);
});

test('the whole macOS store loads and writes back identically', () => {
  const zones = store.presetZones.map(decodePresetZone);
  const written = {
    savedPipelines: decodePipelines(store.savedPipelines)!.map(pipelineToJSON),
    ...Object.fromEntries(SOURCE_KEYS.map(key => [key, Object.fromEntries(Object.entries(decodePipelineSources(store[key])!).map(([source, list]) => [source, list.map(pipelineToJSON)]))])),
    presetZones: zones.map(presetZoneToJSON),
  };
  assert.equal(`${JSON.stringify(written, null, 2)}\n`, fixtureText);
});

test('stored text parses to the stored steps, and the steps written as text parse back to themselves', () => {
  for (const text of allPipelineStrings) {
    const pipeline = decodePipeline(text);
    if (pipeline.rawText) assert.deepEqual(parseSteps(pipeline.rawText, { fileType: pipeline.fileType }), pipeline.steps, pipeline.rawText);
    const canonical = formatSteps(pipeline.steps);
    // Text names a Shortcut but cannot carry its identifier.
    const byName = pipeline.steps.map(step => 'runShortcut' in step ? { runShortcut: { _0: { ...step.runShortcut._0, identifier: step.runShortcut._0.name } } } : step);
    assert.deepEqual(parseSteps(canonical, { fileType: pipeline.fileType }), byName, canonical);
    assert.equal(formatSteps(parseSteps(canonical)), canonical);
  }
});

test('settings load a macOS store, given as Defaults strings or as objects', () => {
  const fromStrings = parseSettings(store, defaultSettings());
  assert.equal(fromStrings.savedPipelines.length, 16);
  assert.deepEqual(Object.keys(fromStrings.pipelinesToRunOnImage), ['clipboard', '~/Downloads']);
  assert.equal(fromStrings.pipelinesToRunOnImage.clipboard[0].libraryID, 'builtin-image-webp');
  assert.equal(fromStrings.presetZones.length, 2);
  assert.deepEqual(fromStrings.savedPipelines.map(pipelineToJSON), store.savedPipelines);
  // What the settings file holds is the Codable object itself, and it loads back unchanged.
  const reloaded = parseSettings(JSON.parse(JSON.stringify(fromStrings)), defaultSettings());
  assert.deepEqual(reloaded, fromStrings);
  assert.deepEqual(reloaded.savedPipelines.map(pipelineToJSON), store.savedPipelines);
});

test('settings drop unreadable pipelines one by one, as the Defaults bridges do', () => {
  const good = store.savedPipelines[0];
  const next = parseSettings({
    savedPipelines: [good, { steps: [{ teleport: {} }] }, 'not json', 42],
    pipelinesToRunOnVideo: { clipboard: [{ steps: [{ capFps: { fps: 0 } }] }, good] },
    presetZones: [{ id: 'x', name: 'x', pipeline: {} }],
  }, defaultSettings());
  assert.deepEqual(next.savedPipelines.map(pipelineToJSON), [good]);
  assert.deepEqual(next.pipelinesToRunOnVideo.clipboard.map(pipelineToJSON), [good]);
  assert.deepEqual(next.presetZones, []);
  // Values of the wrong shape altogether are refused and the current value stays.
  const current = defaultSettings();
  assert.deepEqual(parseSettings({ savedPipelines: { a: 1 }, pipelinesToRunOnImage: { clipboard: 'convert(to: webp)' }, presetZones: 'zone' }, current), current);
});

test('decoding fills in what the Swift decoders default', () => {
  const pipeline = decodePipeline({ steps: [{ optimise: {} }, { convert: { to: 'webp' } }, { delete: {} }, { normalize: {} }, { watermark: { image: 'w.png' } }, { optimise: { compression: { factor: 400 } } }, { optimise: { compression: { tier: 'turbo', factor: 'high' } } }] });
  assert.match(pipeline.id, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  assert.deepEqual(pipeline, {
    id: pipeline.id, skipOptimisation: false, hideResult: false,
    steps: [
      { optimise: { encoder: 'medium', adaptive: false, location: 'inPlace' } },
      { convert: { to: 'webp', location: 'sameFolder' } },
      { delete: { path: 'sourceFile' } },
      { normalize: { lufs: -16 } },
      { watermark: { image: 'w.png', position: 'bottomRight', opacity: 1, scale: 0.15, location: 'inPlace' } },
      { optimise: { encoder: 'medium', adaptive: false, location: 'inPlace', compression: { tier: 'custom', factor: 100 } } },
      { optimise: { encoder: 'medium', adaptive: false, location: 'inPlace', compression: { tier: 'custom', factor: 50 } } },
    ],
  });
  assert.deepEqual(Object.keys(encodePipeline(pipeline)), ['id', 'steps', 'skipOptimisation', 'hideResult']);
  // null is "not present", as with decodeIfPresent.
  assert.deepEqual(decodePipeline({ id: 'n', steps: [{ fork: { location: null } }], name: null, fileType: null }), { id: 'n', steps: [{ fork: {} }], skipOptimisation: false, hideResult: false });
});

test('keys in any order decode to the same pipeline and encode in Swift order', () => {
  const text = store.savedPipelines[11];
  const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)])) : value;
  const shuffled = reverse(JSON.parse(text));
  assert.notEqual(JSON.stringify(shuffled), JSON.stringify(JSON.parse(text)));
  assert.equal(pipelineToJSON(decodePipeline(shuffled)), text);
});

test('steps are primary; rawText is parsed only when steps are empty or unreadable', () => {
  assert.deepEqual(decodePipeline({ id: 'a', steps: [{ stripExif: {} }], rawText: 'removeAudio' }).steps, [{ stripExif: {} }]);
  assert.deepEqual(decodePipeline({ id: 'b', steps: [], rawText: 'removeAudio -> capFps(fps: 24)' }).steps, [{ removeAudio: {} }, { capFps: { fps: 24 } }]);
  assert.deepEqual(decodePipeline({ id: 'c', rawText: 'removeAudio' }).steps, [{ removeAudio: {} }]);
  // A step from a newer macOS that this version cannot read falls back to the text, like the Swift decoder.
  assert.deepEqual(decodePipeline({ id: 'd', steps: [{ upscale: { factor: 2 } }], rawText: 'stripExif' }).steps, [{ stripExif: {} }]);
  // An empty pipeline without text stays empty (a library reference, or nothing attached yet).
  assert.deepEqual(decodePipeline({ id: 'e', steps: [], rawText: '  ' }).steps, []);
});

test('pipelines that cannot be read report why', () => {
  const problem = (value: unknown) => { try { decodePipeline(value); } catch (error) { assert.ok(error instanceof PipelineError); return error.message; } assert.fail('decoded'); };
  assert.equal(problem({ id: 'x', steps: [{ teleport: {} }] }), 'Step 1: Unknown step "teleport"');
  assert.equal(problem({ id: 'x', steps: [{ stripExif: {} }, { capFps: {} }] }), 'Step 2: capFps needs fps');
  assert.equal(problem({ id: 'x', steps: [{ downscale: { factor: '0.5' } }] }), 'Step 1: downscale: factor must be a number, got "0.5"');
  assert.equal(problem({ id: 'x', steps: [{ downscale: { factor: 3 } }] }), 'Step 1: downscale: factor must be a number above 0 and at most 1, got 3');
  assert.equal(problem({ id: 'x', steps: [{ copyToClipboard: { format: 'html' } }] }), 'Step 1: copyToClipboard: format must be one of path, imageData, markdown, got "html"');
  assert.equal(problem({ id: 'x', steps: [{ optimise: {}, removeAudio: {} }] }), 'Step 1: A step holds one case, found optimise, removeAudio');
  assert.equal(problem({ id: 'x', steps: [{ filterIf: { _0: {} } }] }), 'Step 1: if needs at least one condition');
  assert.equal(problem({ id: 'x', steps: [{ filterIf: { _0: { regex: '(' } } }] }), 'Step 1: if: regex is not a valid regular expression: Invalid regular expression: /(/: Unterminated group');
  assert.equal(problem({ id: 'x', name: 'Mine', steps: [{ teleport: {} }], rawText: 'teleport(to: mars)' }), 'Mine: Step 1: Unknown step "teleport"\nMine: Line 1, column 1: Unknown step "teleport"');
  assert.equal(problem({ id: 3, steps: [] }), 'pipeline: id must be a string, got 3');
  assert.equal(problem({ id: 'x', steps: [], fileType: 'document' }), 'pipeline: fileType must be one of image, video, audio, pdf, got "document"');
  assert.equal(problem('{"id": '), 'Not valid JSON: Unexpected end of JSON input');
  assert.equal(problem([]), 'A pipeline must be a JSON object');
  assert.throws(() => decodeStep({ runShortcut: { _0: { identifier: 'x' } } }), /runShortcut needs name/);
});

test('preset zones saved before pipelines turn their shortcut into a runShortcut pipeline', () => {
  const zone = decodePresetZone('{"id":"Resize-image","icon":"wand.and.stars","name":"Resize","type":"image","shortcut":{"name":"Resize","identifier":"ABC"}}');
  assert.deepEqual(zone.pipeline.steps, [{ runShortcut: { _0: { name: 'Resize', identifier: 'ABC' } } }]);
  assert.equal(presetZoneToJSON(zone), `{"id":"Resize-image","icon":"wand.and.stars","name":"Resize","type":"image","pipeline":{"id":"${zone.pipeline.id}","steps":[{"runShortcut":{"_0":{"name":"Resize","identifier":"ABC"}}}],"skipOptimisation":false,"hideResult":false}}`);
  assert.deepEqual(decodePresetZone({ id: 'e', icon: 'i', name: 'Empty' }).pipeline.steps, []);
  assert.throws(() => decodePresetZone({ id: 'e', name: 'No icon' }), /preset zone needs icon/);
});

test('a pipeline built in code encodes in Swift key order', () => {
  const pipeline: Pipeline = { details: 'd', hideResult: true, skipOptimisation: false, steps: [{ crop: { location: 'inPlace', smartCrop: false, width: 5 } }], id: 'X', name: 'n' };
  assert.equal(pipelineToJSON(pipeline), '{"id":"X","steps":[{"crop":{"width":5,"smartCrop":false,"location":"inPlace"}}],"name":"n","skipOptimisation":false,"hideResult":true,"details":"d"}');
});
