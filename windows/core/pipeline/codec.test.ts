import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, parseSettings } from '../settings/schema';
import { SettingsStore } from '../settings/store';
import {
  Unreadable, decodePipeline, decodePipelineSources, decodePipelines, decodePresetZone, decodePresetZones, decodeStep, encodePipeline,
  isReadable, pipelineToJSON, presetZoneToJSON, storedToJSON, type Stored,
} from './codec';
import { STEP_KINDS, effectiveCompression, pipelineProblems, stepKind, type Pipeline } from './model';
import { PipelineError, formatSteps, parseSteps } from './parser';

const fixtureFile = new URL('../../fixtures/pipelines/macos-store.json', import.meta.url);
const fixtureText = readFileSync(fixtureFile, 'utf8');
const store = JSON.parse(fixtureText) as { savedPipelines: string[]; presetZones: string[] } & Record<`pipelinesToRunOn${string}`, Record<string, string[]>>;
const SOURCE_KEYS = ['pipelinesToRunOnImage', 'pipelinesToRunOnVideo', 'pipelinesToRunOnPdf', 'pipelinesToRunOnAudio'] as const;
const allPipelineStrings = [...store.savedPipelines, ...SOURCE_KEYS.flatMap(key => Object.values(store[key]).flat())];
const pipelineJSON = (entry: Stored<Pipeline>) => storedToJSON(entry, pipelineToJSON);
const readable = (entry: Stored<Pipeline> | undefined) => { assert.ok(entry && isReadable(entry), 'readable'); return entry; };

/** What macOS stores and runs but Windows refuses to run: kept and synced back as written. */
const MAC_ONLY = [
  '{"id":"m1","steps":[{"extractPagesAsImages":{"format":"jpg","quality":"medium","location":"sameFolder"}}],"skipOptimisation":false,"hideResult":false,"fileType":"pdf"}',
  '{"id":"m2","steps":[{"normalize":{"lufs":-3}}],"skipOptimisation":false,"hideResult":false}',
  '{"id":"m3","steps":[{"watermark":{"image":"w.png","position":"bottomCenter","opacity":1.5,"scale":1.2,"location":"inPlace"}}],"skipOptimisation":false,"hideResult":false}',
  '{"id":"m4","steps":[{"filterIf":{"_0":{"regex":"(?i)screenshot"}}},{"filterIfNot":{"_0":{"regex":"a++"}}},{"filterIf":{"_0":{"regex":""}}},{"filterIf":{"_0":{}}}],"skipOptimisation":false,"hideResult":false}',
  '{"id":"m5","steps":[{"convert":{"to":"webp","location":""}},{"optimise":{"encoder":"medium","adaptive":false,"dpi":0,"location":"inPlace"}},{"changeSpeed":{"factor":0}}],"skipOptimisation":false,"hideResult":false}',
  '{"id":"m6","steps":[{"optimise":{"encoder":"medium","adaptive":false,"location":"inPlace","compression":{"tier":"turbo","factor":400}}}],"skipOptimisation":false,"hideResult":false}',
];
/** What this version cannot read at all: kept verbatim and synced back, never run. */
const NEWER = [
  '{"id":"n1","steps":[{"upscale":{"factor":2}}],"rawText":"upscale(factor: 2)","skipOptimisation":false,"hideResult":false}',
  '{"id":"n2","steps":[{"stripExif":{}},{"upscale":{"factor":2}}],"rawText":"stripExif","skipOptimisation":false,"hideResult":false}',
  '{"id":"n3","steps":[{"capFps":{}}],"skipOptimisation":false,"hideResult":false}',
];

test('the macOS store fixture covers every step case', () => {
  const kinds = new Set(allPipelineStrings.flatMap(text => decodePipeline(text).steps.map(stepKind)));
  assert.deepEqual(STEP_KINDS.filter(kind => !kinds.has(kind)), []);
});

test('every pipeline in a macOS store re-serialises byte for byte', () => {
  for (const text of allPipelineStrings) assert.equal(pipelineToJSON(decodePipeline(text)), text);
  for (const text of store.presetZones) assert.equal(presetZoneToJSON(decodePresetZone(text)), text);
});

test('the whole macOS store loads and writes back identically', () => {
  const written = {
    savedPipelines: decodePipelines(store.savedPipelines)!.map(pipelineJSON),
    ...Object.fromEntries(SOURCE_KEYS.map(key => [key, Object.fromEntries(Object.entries(decodePipelineSources(store[key])!).map(([source, list]) => [source, list.map(pipelineJSON)]))])),
    presetZones: decodePresetZones(store.presetZones)!.map(zone => storedToJSON(zone, presetZoneToJSON)),
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
  assert.ok(fromStrings.savedPipelines.every(isReadable));
  assert.deepEqual(Object.keys(fromStrings.pipelinesToRunOnImage), ['clipboard', '~/Downloads']);
  assert.equal(readable(fromStrings.pipelinesToRunOnImage.clipboard[0]).libraryID, 'builtin-image-webp');
  assert.equal(fromStrings.presetZones.length, 2);
  assert.deepEqual(fromStrings.savedPipelines.map(pipelineJSON), store.savedPipelines);
  // What the settings file holds is the Codable object itself, and it loads back unchanged.
  const reloaded = parseSettings(JSON.parse(JSON.stringify(fromStrings)), defaultSettings());
  assert.deepEqual(reloaded, fromStrings);
  assert.deepEqual(reloaded.savedPipelines.map(pipelineJSON), store.savedPipelines);
});

test('pipelines macOS stores and runs are kept as written, with warnings for what Windows cannot run', () => {
  for (const text of MAC_ONLY) assert.equal(pipelineToJSON(decodePipeline(text)), text);
  const warnings = MAC_ONLY.map(text => pipelineProblems(decodePipeline(text)).map(({ step, message }) => `${step}: ${message}`));
  assert.deepEqual(warnings, [
    ['0: format must be jpeg or png, got "jpg"'],
    ['0: lufs must be a number from -70 to -5, got -3'],
    ['0: position must be bottomRight, bottomLeft, topRight, topLeft or center, got "bottomCenter"', '0: opacity must be a number from 0 to 1, got 1.5', '0: scale must be a number above 0 and at most 1, got 1.2'],
    ['2: regex needs a value', '3: if needs at least one condition'],
    ['0: location needs a value', '1: dpi must be a whole number above 0, got 0', '2: factor must be a number above 0, got 0'],
    ['0: compression {"tier":"turbo","factor":400} is not a tier Clop knows with a factor from 0 to 100'],
  ]);
  // The executor reads a compression the way the tolerant Swift decoder does.
  assert.deepEqual(effectiveCompression({ tier: 'turbo' as 'custom', factor: 400 }), { tier: 'custom', factor: 100 });
  assert.deepEqual(effectiveCompression({ factor: 'high' } as never), { tier: 'custom', factor: 50 });
});

test('values a newer macOS adds are kept and written back', () => {
  const text = '{"id":"x","steps":[{"optimise":{"encoder":"medium","adaptive":false,"location":"inPlace","preset":"web"}},{"filterIf":{"_0":{"regex":"a","colour":"red"}}},{"runShortcut":{"_0":{"name":"S","identifier":"I","folder":"F"}}}],"skipOptimisation":false,"hideResult":false,"colour":"teal"}';
  assert.equal(pipelineToJSON(decodePipeline(text)), text);
  const zone = '{"id":"z","icon":"i","name":"Z","pipeline":{"id":"p","steps":[],"skipOptimisation":false,"hideResult":false},"order":3}';
  assert.equal(presetZoneToJSON(decodePresetZone(zone)), zone);
  // Code that builds a pipeline in another key order still writes Swift's order, extras last.
  const built = { colour: 'teal', ...decodePipeline(text), name: 'n' };
  assert.equal(pipelineToJSON(built), text.replace('"skipOptimisation"', '"name":"n","skipOptimisation"'));
});

test('entries this version cannot read are kept verbatim in settings', () => {
  const entries = [store.savedPipelines[0], ...NEWER, JSON.parse(NEWER[0]), 'not json', 42];
  const next = parseSettings({ savedPipelines: entries, pipelinesToRunOnVideo: { clipboard: [NEWER[2], store.savedPipelines[4]] }, presetZones: [{ id: 'x', name: 'x', pipeline: {} }] }, defaultSettings());
  assert.deepEqual(next.savedPipelines.map(isReadable), [true, false, false, false, false, false, false]);
  assert.deepEqual(next.savedPipelines.map(pipelineJSON), [store.savedPipelines[0], ...NEWER, NEWER[0], 'not json', '42']);
  assert.deepEqual(JSON.parse(JSON.stringify(next.savedPipelines.slice(1))), entries.slice(1));
  assert.match((next.savedPipelines[1] as Unreadable).reason, /Unknown step "upscale"/);
  assert.deepEqual(next.pipelinesToRunOnVideo.clipboard.map(pipelineJSON), [NEWER[2], store.savedPipelines[4]]);
  assert.deepEqual(JSON.parse(JSON.stringify(next.presetZones)), [{ id: 'x', name: 'x', pipeline: {} }]);
  // Parsing the parsed settings again neither unwraps nor double-wraps them.
  assert.deepEqual(parseSettings(next, defaultSettings()), next);
  // Values of the wrong shape altogether are refused and the current value stays.
  const current = defaultSettings();
  assert.deepEqual(parseSettings({ savedPipelines: { a: 1 }, pipelinesToRunOnImage: { clipboard: 'convert(to: webp)' }, presetZones: 'zone' }, current), current);
});

test('saving and loading settings loses no macOS pipeline', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-pipelines-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const saved = [...store.savedPipelines, ...MAC_ONLY, ...NEWER];
  const zones = [...store.presetZones, '{"id":"bad","icon":"i"}'];
  const first = new SettingsStore(file);
  await first.load();
  await first.set({ savedPipelines: saved, pipelinesToRunOnAudio: { '~/Music/Inbox': [NEWER[0], MAC_ONLY[1]] }, presetZones: zones });
  await first.set({ autoCopyToClipboard: false });
  for (let round = 0; round < 2; round++) {
    const loaded = await new SettingsStore(file).load();
    assert.deepEqual(loaded.savedPipelines.map(pipelineJSON), saved);
    assert.deepEqual(loaded.pipelinesToRunOnAudio['~/Music/Inbox'].map(pipelineJSON), [NEWER[0], MAC_ONLY[1]]);
    assert.deepEqual(loaded.presetZones.map(zone => storedToJSON(zone, presetZoneToJSON)), zones);
    const again = new SettingsStore(file);
    await again.load();
    await again.save();
  }
  // The unreadable entries sit in the file exactly as they were given.
  const onDisk = JSON.parse(await readFile(file, 'utf8')) as { savedPipelines: unknown[]; presetZones: unknown[] };
  assert.deepEqual(onDisk.savedPipelines.slice(-NEWER.length), NEWER);
  assert.equal(onDisk.presetZones.at(-1), '{"id":"bad","icon":"i"}');
});

test('decoding fills in what the Swift decoders default', () => {
  const pipeline = decodePipeline({ steps: [{ optimise: {} }, { convert: { to: 'webp' } }, { delete: {} }, { normalize: {} }, { watermark: { image: 'w.png' } }, { optimise: { compression: { factor: 40 } } }] });
  assert.match(pipeline.id, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  assert.deepEqual(pipeline, {
    id: pipeline.id, skipOptimisation: false, hideResult: false,
    steps: [
      { optimise: { encoder: 'medium', adaptive: false, location: 'inPlace' } },
      { convert: { to: 'webp', location: 'sameFolder' } },
      { delete: { path: 'sourceFile' } },
      { normalize: { lufs: -16 } },
      { watermark: { image: 'w.png', position: 'bottomRight', opacity: 1, scale: 0.15, location: 'inPlace' } },
      { optimise: { encoder: 'medium', adaptive: false, location: 'inPlace', compression: { factor: 40 } } },
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

test('steps are primary; rawText is parsed only when steps are missing or empty', () => {
  assert.deepEqual(decodePipeline({ id: 'a', steps: [{ stripExif: {} }], rawText: 'removeAudio' }).steps, [{ stripExif: {} }]);
  assert.deepEqual(decodePipeline({ id: 'b', steps: [], rawText: 'removeAudio -> capFps(fps: 24)' }).steps, [{ removeAudio: {} }, { capFps: { fps: 24 } }]);
  assert.deepEqual(decodePipeline({ id: 'c', rawText: 'removeAudio' }).steps, [{ removeAudio: {} }]);
  // Stored text is read as macOS reads it: values Windows cannot run are kept.
  assert.deepEqual(decodePipeline({ id: 'd', rawText: 'normalize(lufs: -3) -> watermark(image: w.png, position: bottomCenter)' }).steps,
    [{ normalize: { lufs: -3 } }, { watermark: { image: 'w.png', position: 'bottomCenter', opacity: 1, scale: 0.15, location: 'inPlace' } }]);
  // Steps from a newer macOS are not replaced by the text: the pipeline stays unreadable here and is kept as it is.
  assert.throws(() => decodePipeline(NEWER[1]), /Step 2: Unknown step "upscale"/);
  // An empty pipeline without text stays empty (a library reference, or nothing attached yet).
  assert.deepEqual(decodePipeline({ id: 'e', steps: [], rawText: '  ' }).steps, []);
});

test('pipelines that cannot be read report why', () => {
  const problem = (value: unknown) => { try { decodePipeline(value); } catch (error) { assert.ok(error instanceof PipelineError); return error.message; } assert.fail('decoded'); };
  assert.equal(problem({ id: 'x', steps: [{ teleport: {} }] }), 'Step 1: Unknown step "teleport"');
  assert.equal(problem({ id: 'x', steps: [{ stripExif: {} }, { capFps: {} }] }), 'Step 2: capFps needs fps');
  assert.equal(problem({ id: 'x', steps: [{ downscale: { factor: '0.5' } }] }), 'Step 1: downscale: factor must be a number, got "0.5"');
  assert.equal(problem({ id: 'x', steps: [{ copyToClipboard: { format: 'html' } }] }), 'Step 1: copyToClipboard: format must be one of path, imageData, markdown, got "html"');
  assert.equal(problem({ id: 'x', steps: [{ optimise: {}, removeAudio: {} }] }), 'Step 1: A step holds one case, found optimise, removeAudio');
  assert.equal(problem({ id: 'x', steps: [{ filterIf: { _0: { types: 'png' } } }] }), 'Step 1: if: types must be a list of strings');
  assert.equal(problem({ id: 'x', name: 'Mine', steps: [], rawText: 'teleport(to: mars)' }), 'Mine: Line 1, column 1: Unknown step "teleport"');
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
