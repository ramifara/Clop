import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, parseSettings, type ClopSettings } from '../settings/schema';
import { Unreadable, decodePipelines, decodePresetZones, isReadable } from './codec';
import { seedBuiltinPipelines } from './builtins';
import { LIMITS, applyCommand, parseCommand, type EditorCommand } from './editor-commands';
import { editorState, entryKeys, revisionOf, type EditorSettings, type PipelineView } from './editor-state';
import type { Pipeline, PresetZone } from './model';
import { pipelinesFor } from './triggers';

const deepFreeze = <T>(value: T): T => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); } return value; };
/** Settings with the built-ins and watched folders of a Windows user, frozen so a command cannot change them in place. */
function fixture(extra: Partial<ClopSettings> = {}) {
  const base = defaultSettings(), seeded = seedBuiltinPipelines(base.savedPipelines, 0)!;
  return deepFreeze({ ...base, ...seeded, imageDirs: ['C:\\Users\\Rami\\Desktop', '~/Pictures/Shots'], videoDirs: ['~/Videos'], ...extra }) as ClopSettings;
}
const windows = { home: 'C:\\Users\\Rami', platform: 'win32' as const };
/** Applies a command and the patch it returns, as the settings store does. */
function run(settings: ClopSettings, command: unknown) {
  const result = applyCommand(settings, command, windows);
  return { result, settings: deepFreeze(parseSettings(result.patch, settings)) };
}
const save = (over: Partial<Extract<EditorCommand, { type: 'pipeline-save' }>> = {}): EditorCommand => ({ type: 'pipeline-save', name: 'Small PNGs', fileType: 'image', skipOptimisation: false, hideResult: false, view: 'text', text: 'downscale(factor: 0.5) -> optimise', ...over });
/** The revision the window would show for the entry with this key. */
function rev(settings: EditorSettings, key: string): string {
  const view = editorState(settings, windows), all = [...view.library, ...view.zones, ...Object.values(view.attachments).flat().flatMap(source => source.entries)];
  return all.find(entry => entry.key === key)?.revision ?? 'missing';
}
const named = (settings: EditorSettings, name: string) => settings.savedPipelines.filter(isReadable).find(entry => entry.name === name)!;

test('malformed commands are refused whole, whatever the caller sends', () => {
  const bad: unknown[] = [undefined, null, 'attach', [], {}, { type: 'rm -rf' }, { type: 'attach', fileType: 'image', source: 'clipboard' },
    { type: 'attach', fileType: 'gif', source: 'clipboard', pipelineId: 'x' }, { type: 'attach', fileType: 'image', source: 7, pipelineId: 'x' }, { type: 'attach', fileType: 'image', source: '', pipelineId: 'x' },
    { type: 'attach', fileType: 'image', source: 'clipboard', pipelineId: 'x'.repeat(LIMITS.id + 1) },
    { type: 'pipeline-save', name: 'a', skipOptimisation: false, hideResult: false, view: 'text', text: 1 }, { ...save(), view: 'xml' }, { ...save(), name: '  ' }, { ...save(), text: 'x'.repeat(LIMITS.text + 1) }, { ...save(), skipOptimisation: 'yes' }, { ...save(), icon: 7 }, { ...save(), icon: 'x'.repeat(LIMITS.path + 1) }, { ...save(), fileType: 'gif' }, { ...save(), id: 5 },
    { type: 'zone-save', name: 'a', icon: 'photo', pipelineId: {} }, { type: 'zone-move', key: 'a', to: -1 }, { type: 'zone-move', key: 'a', to: 1.5 }, { type: 'zone-move', key: 'a', to: LIMITS.zones }, { type: 'zone-delete', key: 'z' }, { type: 'pipeline-delete', key: 'p' }];
  for (const command of bad) assert.throws(() => applyCommand(fixture(), command), /invalid|Error/, JSON.stringify(command));
  assert.deepEqual(parseCommand({ type: 'zone-delete', key: 'z', base: 'r', extra: 'ignored' }), { type: 'zone-delete', key: 'z', base: 'r' }, 'unknown fields are dropped');
});

test('saving a pipeline from text adds it to the library with the text the user wrote, cleaned', () => {
  const before = fixture(), { result, settings } = run(before, save({ text: 'move(to: "C:\\Users\\Rami\\Pictures\\out")-> optimise', icon: 'photo', details: ' Shrinks ' }));
  assert.equal(result.issues, undefined);
  const saved = settings.savedPipelines.filter(isReadable).find(entry => entry.id === result.saved)!;
  assert.deepEqual([saved.name, saved.fileType, saved.icon, saved.details, saved.rawText], ['Small PNGs', 'image', 'photo', 'Shrinks', 'move(to: "~\\Pictures\\out") -> optimise']);
  assert.equal(saved.steps.length, 2);
  assert.equal(settings.savedPipelines.length, before.savedPipelines.length + 1);
  assert.equal(before.savedPipelines.length, 11, 'the settings it was given are untouched');
});

test('what the user wrote that does not parse comes back at its position, and nothing is saved', () => {
  const before = fixture(), { result } = run(before, save({ text: 'optimise -> crop(widht: 100)' }));
  assert.deepEqual(result.patch, {});
  assert.equal(result.issues!.length, 1);
  assert.match(result.issues![0].message, /no parameter "widht"; did you mean width\?/);
  assert.deepEqual([result.issues![0].line, result.issues![0].column], [1, 18]);
  assert.match(run(before, save({ text: '  ' })).result.issues![0].message, /at least one step/);
  assert.match(run(before, save({ fileType: 'image', text: 'removeAudio' })).result.issues![0].message, /./, 'steps for another file type are refused');
  assert.match(run(before, save({ view: 'json', text: '[{"optimise":{}} {"x":1}]' })).result.issues![0].message, /^Not valid JSON/);
});

test('a step with no exact text form is saved from the JSON view, without a text form', () => {
  const json = '[\n  // keep\n  {"runScript":{"code":"echo \\"a -> b\\""}},\n]';
  const { result, settings } = run(fixture(), save({ name: 'Script', fileType: undefined, view: 'json', text: json }));
  assert.equal(result.issues, undefined);
  const view = editorState(settings, windows).library.find(entry => entry.key === result.saved)!;
  assert.ok(view.readable && !view.exact && view.text === '' && view.json.includes('runScript'));
  const all = run(fixture(), save({ name: 'Plain', view: 'json', text: '[{"downscale":{"factor":0.5,"location":"inPlace"}}]' }));
  assert.equal(named(all.settings, 'Plain').rawText, 'downscale(factor: 0.5)', 'steps that can be written as text get their text');
});

test('editing a library pipeline keeps its id and what macOS stored beyond what Windows knows; a built-in can be edited', () => {
  const start = fixture();
  const builtin = named(start, 'to WebP'), { result, settings } = run(start, save({ id: builtin.id, base: rev(start, builtin.id), name: 'to WebP', fileType: 'image', text: 'convert(to: webp, location: sameFolder)' }));
  assert.equal(result.saved, 'builtin-image-webp');
  assert.equal(settings.savedPipelines.length, start.savedPipelines.length);
  assert.equal(named(settings, 'to WebP').rawText, 'convert(to: webp, location: sameFolder)', 'the text stays as the user wrote it');
  const newer = decodePipelines([{ id: 'MAC', name: 'From Mac', futureField: [1, 2], steps: [{ optimise: {} }] }]) as Pipeline[];
  const withMac = deepFreeze({ ...start, savedPipelines: [...start.savedPipelines, ...newer] });
  const kept = run(withMac, save({ id: 'MAC', base: rev(withMac, 'MAC'), name: 'Renamed', fileType: undefined, text: 'optimise' }));
  assert.equal((named(kept.settings, 'Renamed') as unknown as { futureField: number[] }).futureField.length, 2);
  assert.match(run(start, save({ id: 'GONE', base: 'x' })).result.issues![0].message, /no longer in the library/);
});

test('a pipeline cannot be limited to a file type while it is attached to another', () => {
  let { settings } = run(fixture(), save({ name: 'Any', fileType: undefined, text: 'optimise' }));
  const id = named(settings, 'Any').id;
  settings = run(settings, { type: 'attach', fileType: 'video', source: 'clipboard', pipelineId: id }).settings;
  const refused = run(settings, save({ id, base: rev(settings, id), name: 'Any', fileType: 'image', text: 'optimise' }));
  assert.match(refused.result.issues![0].message, /attached to video clipboard/);
  assert.equal(run(settings, save({ id, base: rev(settings, id), name: 'Any', fileType: 'video', text: 'optimise' })).result.issues, undefined);
});

test('attaching puts a reference in the clipboard, drop zone or watched folder of that type and detaching takes it out', () => {
  let { settings } = run(fixture(), save());
  const id = named(settings, 'Small PNGs').id;
  const attach = (source: string, fileType = 'image', pipelineId = id) => run(settings, { type: 'attach', fileType, source, pipelineId });
  for (const source of ['clipboard', 'dropZone', 'C:\\Users\\Rami\\Desktop', 'c:/users/rami/pictures/shots']) {
    const step = attach(source);
    assert.equal(step.result.issues, undefined, source);
    settings = step.settings;
  }
  assert.deepEqual(Object.keys(settings.pipelinesToRunOnImage), ['clipboard', 'dropZone', 'C:\\Users\\Rami\\Desktop', '~/Pictures/Shots'], 'a folder keeps the key it is listed under');
  for (const source of ['clipboard', 'dropZone', 'C:\\Users\\Rami\\Desktop', 'C:\\Users\\Rami\\Pictures\\Shots'])
    assert.deepEqual(pipelinesFor('image', source, settings, windows).map(p => p.id), [id], `${source} runs it`);
  assert.deepEqual(pipelinesFor('video', 'clipboard', settings, windows), []);

  const sources = editorState(settings, windows).attachments.image;
  assert.deepEqual(sources.map(source => [source.label, source.entries.map(entry => entry.name)]), [['Clipboard', ['Small PNGs']], ['Drop zone', ['Small PNGs']], ['C:\\Users\\Rami\\Desktop', ['Small PNGs']], ['~/Pictures/Shots', ['Small PNGs']]]);
  const entry = sources[0].entries[0];
  settings = run(settings, { type: 'detach', fileType: 'image', source: 'clipboard', key: entry.key, base: entry.revision }).settings;
  assert.deepEqual(pipelinesFor('image', 'clipboard', settings, windows), []);
  assert.equal(Object.hasOwn(settings.pipelinesToRunOnImage, 'clipboard'), false, 'an empty source is dropped');
  assert.match(run(settings, { type: 'detach', fileType: 'image', source: 'clipboard', key: entry.key, base: entry.revision }).result.issues![0].message, /no longer attached/);
});

test('attaching is refused for the wrong file type, an unwatched folder, a duplicate or a full place', () => {
  let { settings } = run(fixture(), save({ name: 'Video only', fileType: 'video', text: 'removeAudio' }));
  const video = named(settings, 'Video only').id, message = (command: object) => run(settings, command).result.issues?.[0].message;
  assert.match(message({ type: 'attach', fileType: 'image', source: 'clipboard', pipelineId: video })!, /works on video files, not image files/);
  assert.match(message({ type: 'attach', fileType: 'video', source: 'C:\\Windows', pipelineId: video })!, /not a clipboard, drop zone or watched video folder/);
  assert.match(message({ type: 'attach', fileType: 'video', source: 'C:\\Users\\Rami\\Desktop', pipelineId: video })!, /not a clipboard, drop zone or watched video folder/, 'the Desktop is watched for images only');
  assert.match(message({ type: 'attach', fileType: 'video', source: 'clipboard', pipelineId: 'NOPE' })!, /no longer in the library/);
  settings = run(settings, { type: 'attach', fileType: 'video', source: 'clipboard', pipelineId: video }).settings;
  assert.match(message({ type: 'attach', fileType: 'video', source: 'clipboard', pipelineId: video })!, /already attached/);
  const full = deepFreeze({ ...settings, pipelinesToRunOnVideo: { dropZone: Array.from({ length: LIMITS.perSource }, (_, i) => ({ id: `E${i}`, steps: [], skipOptimisation: false, hideResult: false, libraryID: `L${i}` })) } });
  assert.match(applyCommand(full, { type: 'attach', fileType: 'video', source: 'dropZone', pipelineId: video }, windows).issues![0].message, /At most 20/);
});

test('entries this version cannot read stay in place through every command, and can be fixed or removed', () => {
  const start = fixture({
    savedPipelines: [...fixture().savedPipelines, ...decodePipelines([{ id: 'NEW', name: 'From the future', steps: [{ teleport: {} }] }])!],
    pipelinesToRunOnImage: { clipboard: decodePipelines([{ id: 'NEWER', steps: [{ teleport: {} }] }])! },
    presetZones: decodePresetZones([{ id: 'ZONE-NEW', name: 'Z', icon: 'x', pipeline: { id: 'P', steps: [{ teleport: {} }] } }])!,
  });
  const unreadable = start.savedPipelines.at(-1) as Unreadable;
  assert.ok(unreadable instanceof Unreadable);
  const view = editorState(start, windows).library.at(-1)!;
  assert.ok(!view.readable && view.id === 'NEW' && view.raw.includes('teleport') && view.key.startsWith('unreadable:'));

  let { settings } = run(start, save());
  assert.ok(settings.savedPipelines.at(-2) === unreadable, 'it stays where it was, as the same object');
  const id = named(settings, 'Small PNGs').id;
  settings = run(settings, { type: 'attach', fileType: 'image', source: 'clipboard', pipelineId: id }).settings;
  assert.equal(settings.pipelinesToRunOnImage.clipboard.length, 2);
  assert.ok(settings.pipelinesToRunOnImage.clipboard[0] instanceof Unreadable);
  settings = run(settings, { type: 'zone-save', name: 'Small', icon: 'photo', fileType: 'image', pipelineId: id }).settings;
  assert.ok(settings.presetZones[0] instanceof Unreadable && settings.presetZones.length === 2);

  assert.match(run(settings, { type: 'pipeline-fix', key: view.key, base: view.revision, json: '{"name":"x","steps":[{"teleport":{}}]}' }).result.issues![0].message, /teleport/);
  assert.match(run(settings, { type: 'pipeline-fix', key: id, base: rev(settings, id), json: '{}' }).result.issues![0].message, /could not be read/);
  assert.match(run(settings, { type: 'pipeline-fix', key: view.key, base: view.revision, json: '{"steps":[{"optimise":{}}]}' }).result.issues![0].message, /name/);
  const fixed = run(settings, { type: 'pipeline-fix', key: view.key, base: view.revision, json: JSON.stringify({ id: 'OTHER', name: 'Fixed', steps: [{ optimise: {} }] }) });
  assert.equal(fixed.result.saved, 'NEW', 'the id stays so references keep working');
  assert.ok(isReadable(fixed.settings.savedPipelines.at(-2)!) && named(fixed.settings, 'Fixed').id === 'NEW');
  const gone = run(settings, { type: 'pipeline-delete', key: view.key, base: view.revision });
  assert.equal(gone.settings.savedPipelines.length, settings.savedPipelines.length - 1);
  assert.ok(gone.settings.pipelinesToRunOnImage.clipboard[0] instanceof Unreadable, 'removing one entry leaves the others');
});

test('deleting a pipeline detaches it everywhere and removes the preset zones that ran it', () => {
  let { settings } = run(fixture(), save());
  const id = named(settings, 'Small PNGs').id;
  settings = run(settings, { type: 'attach', fileType: 'image', source: 'clipboard', pipelineId: id }).settings;
  settings = run(settings, { type: 'attach', fileType: 'image', source: 'dropZone', pipelineId: id }).settings;
  settings = run(settings, { type: 'attach', fileType: 'image', source: 'dropZone', pipelineId: 'builtin-image-webp' }).settings;
  settings = run(settings, { type: 'zone-save', name: 'Small', icon: 'photo', fileType: 'image', pipelineId: id }).settings;
  const { result, settings: after } = run(settings, { type: 'pipeline-delete', key: id, base: rev(settings, id) });
  assert.deepEqual(result.removed, { attachments: 2, zones: 1 });
  assert.equal(after.presetZones.length, 0);
  assert.deepEqual(Object.keys(after.pipelinesToRunOnImage), ['dropZone']);
  assert.deepEqual(pipelinesFor('image', 'dropZone', after, windows).map(p => p.id), ['builtin-image-webp']);
  assert.equal(after.savedPipelines.some(entry => isReadable(entry) && entry.id === id), false);
  assert.match(run(after, { type: 'pipeline-delete', key: id, base: 'x' }).result.issues![0].message, /no longer in the library/);
});

test('preset zones are added, edited, reordered and removed, running a library pipeline that fits their file type', () => {
  let { settings } = run(fixture(), save());
  const any = run(settings, save({ name: 'Any', fileType: undefined, text: 'optimise' }));
  assert.equal(run(any.settings, { type: 'zone-save', name: 'Everything', icon: 'bolt', pipelineId: any.result.saved }).result.issues, undefined, 'a pipeline for any type serves a zone of any type');
  const small = named(settings, 'Small PNGs').id;
  const zone = (over: object) => ({ type: 'zone-save', name: 'Zone', icon: 'photo', ...over });
  const first = run(settings, zone({ name: 'Shrink', fileType: 'image', pipelineId: small }));
  assert.equal(first.result.issues, undefined);
  settings = first.settings;
  settings = run(settings, zone({ name: 'Audio', icon: 'music.note', fileType: 'audio', pipelineId: 'builtin-audio-to-mp3' })).settings;
  assert.deepEqual(settings.presetZones.map(z => isReadable(z) && z.name), ['Shrink', 'Audio']);
  const [shrink, audio] = settings.presetZones as PresetZone[];
  assert.equal(shrink.pipeline.libraryID, small);

  assert.match(run(settings, zone({ fileType: 'video', pipelineId: small })).result.issues![0].message, /works on image files/);
  assert.match(run(settings, zone({ pipelineId: 'builtin-audio-to-mp3' })).result.issues![0].message, /works on audio files/);
  assert.match(run(settings, zone({})).result.issues![0].message, /Choose the pipeline/);
  assert.match(run(settings, zone({ id: 'GONE', base: 'x', pipelineId: small })).result.issues![0].message, /no longer exists/);

  const renamed = run(settings, zone({ id: shrink.id, base: rev(settings, shrink.id), name: 'Squash', icon: 'bolt', fileType: 'image' }));
  const kept = renamed.settings.presetZones[0] as PresetZone;
  assert.deepEqual([kept.id, kept.name, kept.icon, kept.pipeline.id], [shrink.id, 'Squash', 'bolt', shrink.pipeline.id], 'the zone and its reference keep their ids when only the label changes');

  const moved = run(settings, { type: 'zone-move', key: audio.id, to: 0 }).settings;
  assert.deepEqual(moved.presetZones.map(z => (z as PresetZone).name), ['Audio', 'Shrink']);
  assert.deepEqual(run(settings, { type: 'zone-move', key: shrink.id, to: 0 }).result.patch, {});
  assert.deepEqual(run(settings, { type: 'zone-move', key: shrink.id, to: 30 }).settings.presetZones.map(z => (z as PresetZone).name), ['Audio', 'Shrink'], 'past the end means last');
  assert.deepEqual(run(settings, { type: 'zone-delete', key: shrink.id, base: rev(settings, shrink.id) }).settings.presetZones.map(z => (z as PresetZone).name), ['Audio']);
  assert.match(run(settings, { type: 'zone-delete', key: 'GONE', base: 'x' }).result.issues![0].message, /no longer exists/);

  const full = deepFreeze({ ...settings, presetZones: Array.from({ length: LIMITS.zones }, (_, i) => ({ ...shrink, id: `Z${i}` })) });
  assert.match(applyCommand(full, zone({ pipelineId: small }), windows).issues![0].message, /room for 40/);
  const view = editorState(settings, windows).zones;
  assert.deepEqual(view.map(z => [z.name, z.type, z.pipelineName, z.missing]), [['Shrink', 'image', 'Small PNGs', undefined], ['Audio', 'audio', 'to MP3', undefined]]);
});

/** Unreadable entries: one with an id, one without, one more with the same id as the first. */
function withUnreadable() {
  const entries = decodePipelines([
    { id: 'FUT-A', name: 'A', steps: [{ teleport: { to: 'moon' } }] },
    { name: 'No id', steps: [{ warp: {} }] },
    { id: 'FUT-A', name: 'A again', steps: [{ teleport: { to: 'mars' } }] },
  ])!;
  const base = fixture();
  return fixture({ savedPipelines: [...entries, ...base.savedPipelines] });
}
const unreadableViews = (settings: ClopSettings) => editorState(settings, windows).library.filter(entry => !entry.readable);

test('unreadable entries are named by what they are, not where they are, and the keys are unique', () => {
  const settings = withUnreadable(), [a, noId, again] = unreadableViews(settings);
  assert.equal(new Set([a.key, noId.key, again.key]).size, 3);
  assert.equal(a.key, 'unreadable:id:FUT-A');
  assert.ok(noId.key.startsWith('unreadable:raw:'), 'no id: a hash of what it holds');
  assert.ok(!a.readable && !noId.readable && a.revision === revisionOf(settings.savedPipelines[0]));
  // Putting something in front, or taking something out, does not change any key.
  const shifted = fixture({ savedPipelines: [...fixture().savedPipelines, ...settings.savedPipelines.slice(1)] });
  const after = unreadableViews(shifted);
  assert.equal(after[0].key, noId.key);
  assert.equal(entryKeys(settings.savedPipelines).length, settings.savedPipelines.length);
});

test('a fix or delete aimed at an unreadable entry that moved or changed is refused, never applied to its neighbour', () => {
  const settings = withUnreadable(), [a, noId] = unreadableViews(settings);
  assert.ok(!a.readable && !noId.readable);
  // Removed elsewhere: the key no longer names anything, even though another entry now sits at its position.
  const removed = fixture({ savedPipelines: settings.savedPipelines.filter((_, index) => index !== 1) });
  for (const command of [{ type: 'pipeline-delete', key: noId.key, base: noId.revision }, { type: 'pipeline-fix', key: noId.key, base: noId.revision, json: '{"name":"x","steps":[{"optimise":{}}]}' }]) {
    const { result } = run(removed, command);
    assert.deepEqual(result.patch, {});
    assert.match(result.issues![0].message, /no longer|changed elsewhere/);
  }
  // Same id but replaced by other contents: the revision the editor saw no longer matches.
  const replaced = fixture({ savedPipelines: [...decodePipelines([{ id: 'FUT-A', name: 'Replaced', steps: [{ teleport: { to: 'venus' } }] }])!, ...settings.savedPipelines.slice(1)] });
  const refused = run(replaced, { type: 'pipeline-delete', key: a.key, base: a.revision });
  assert.deepEqual(refused.result.patch, {});
  assert.equal(refused.result.conflict, true);
  assert.match(refused.result.issues![0].message, /changed elsewhere/);
  // The right key and revision still work, wherever the entry is now.
  const front = fixture({ savedPipelines: [...fixture().savedPipelines, ...settings.savedPipelines] });
  const viewNow = unreadableViews(front).find(view => view.key === noId.key)!;
  assert.equal(run(front, { type: 'pipeline-delete', key: noId.key, base: noId.revision }).settings.savedPipelines.length, front.savedPipelines.length - 1);
  assert.ok(viewNow.key === noId.key);
  // A command that names no revision cannot touch an unreadable entry.
  assert.throws(() => applyCommand(settings, { type: 'pipeline-delete', key: a.key }), /invalid/);
});

test('attached and zone unreadable entries are keyed by identity too', () => {
  const start = fixture({
    pipelinesToRunOnImage: { clipboard: decodePipelines([{ id: 'X1', steps: [{ teleport: {} }] }, { id: 'X2', steps: [{ teleport: {} }] }])! },
    presetZones: decodePresetZones([{ id: 'Z1', name: 'Z', icon: 'x', pipeline: { id: 'P', steps: [{ teleport: {} }] } }, { id: 'Z2', name: 'Z', icon: 'x', pipeline: { id: 'Q', steps: [{ teleport: {} }] } }])!,
  });
  const view = editorState(start, windows);
  const [x1, x2] = view.attachments.image[0].entries, [z1, z2] = view.zones;
  assert.deepEqual([x1.key, x2.key, z1.key, z2.key], ['unreadable:id:X1', 'unreadable:id:X2', 'unreadable:id:Z1', 'unreadable:id:Z2']);
  const gone = run(start, { type: 'detach', fileType: 'image', source: 'clipboard', key: x1.key, base: x1.revision }).settings;
  assert.equal(editorState(gone, windows).attachments.image[0].entries[0].key, 'unreadable:id:X2');
  assert.equal(run(gone, { type: 'detach', fileType: 'image', source: 'clipboard', key: x1.key, base: x1.revision }).result.issues![0].message.includes('no longer'), true);
  const zoneGone = run(start, { type: 'zone-delete', key: z1.key, base: z1.revision }).settings;
  assert.equal(zoneGone.presetZones.length, 1);
  assert.match(run(zoneGone, { type: 'zone-delete', key: z1.key, base: z1.revision }).result.issues![0].message, /no longer/);
});

test('a save of an existing pipeline or zone is refused when the entry changed since the window showed it, and a save without a base is malformed', () => {
  let { settings } = run(fixture(), save());
  const id = named(settings, 'Small PNGs').id, shown = rev(settings, id);
  settings = run(settings, { type: 'zone-save', name: 'Shrink', icon: 'photo', fileType: 'image', pipelineId: id }).settings;
  const zoneId = (settings.presetZones[0] as PresetZone).id, zoneShown = rev(settings, zoneId);
  // Someone else (the CLI, MCP, another window) changes both after the window drew them.
  const elsewhere = run(settings, save({ id, base: shown, name: 'Small PNGs (theirs)', text: 'optimise' })).settings;
  const zoneElsewhere = run(elsewhere, { type: 'zone-save', id: zoneId, base: zoneShown, name: 'Theirs', icon: 'bolt', fileType: 'image' }).settings;
  const stale = run(zoneElsewhere, save({ id, base: shown, name: 'Mine', text: 'downscale(factor: 0.2)' }));
  assert.equal(stale.result.conflict, true);
  assert.deepEqual(stale.result.patch, {}, 'nothing is written');
  assert.match(stale.result.issues![0].message, /changed elsewhere/);
  assert.equal(named(stale.settings, 'Small PNGs (theirs)').rawText, 'optimise');
  const staleZone = run(zoneElsewhere, { type: 'zone-save', id: zoneId, base: zoneShown, name: 'Mine', icon: 'photo', fileType: 'image' });
  assert.equal(staleZone.result.conflict, true);
  assert.deepEqual(staleZone.result.patch, {});
  // Overwriting is the window asking again with the revision it now shows.
  const again = run(zoneElsewhere, save({ id, base: rev(zoneElsewhere, id), name: 'Mine', text: 'downscale(factor: 0.2)' }));
  assert.equal(again.result.conflict, undefined);
  assert.equal(named(again.settings, 'Mine').rawText, 'downscale(factor: 0.2)');
  // A rename that lands on an equal entry is not a conflict: the revision is of the content.
  assert.equal(run(settings, save({ id, base: shown, name: 'Small PNGs', text: 'downscale(factor: 0.5) -> optimise' })).result.conflict, undefined);
  for (const bad of [save({ id }), { type: 'zone-save', id: zoneId, name: 'x', icon: 'photo' }]) assert.throws(() => applyCommand(settings, bad, windows), /invalid revision/);
});

test('values already stored that Windows would not accept do not block a rename or a flag change, but new ones are held to the limits', () => {
  const longName = 'N'.repeat(LIMITS.name + 20), longDetails = 'D'.repeat(LIMITS.details + 50), oddIcon = 'icon with spaces';
  const start = fixture({
    savedPipelines: [...fixture().savedPipelines, ...decodePipelines([{ id: 'OLD', name: longName, details: longDetails, icon: oddIcon, fileType: 'image', steps: [{ downscale: { factor: 0 } }] }, { id: 'OLD2', name: 'Text one', rawText: 'downscale(factor: 2)' }])!],
    presetZones: decodePresetZones([{ id: 'ZOLD', name: 'Z'.repeat(LIMITS.zoneName + 10), icon: oddIcon, fileType: 'image' }])!,
  });
  assert.ok(named(start, longName), 'the stored pipeline is readable');
  const base = rev(start, 'OLD'), view = editorState(start, windows).library.find(entry => entry.key === 'OLD')!;
  assert.ok(view.readable);
  const json = (view as PipelineView).json;
  assert.match(json, /factor/);
  // Same steps, same labels, only a flag changes: the stored name, description, icon and step value pass through.
  const flag = run(start, save({ id: 'OLD', base, name: longName, details: longDetails, icon: oddIcon, view: 'json', text: json, hideResult: true }));
  assert.equal(flag.result.issues, undefined, JSON.stringify(flag.result.issues));
  assert.equal(named(flag.settings, longName).hideResult, true);
  // The step text as the window shows it saves too.
  const second = editorState(start, windows).library.find(entry => entry.key === 'OLD2') as PipelineView;
  assert.match(second.text, /downscale/);
  const text = run(start, save({ id: 'OLD2', base: second.revision, name: 'Text renamed', text: second.text, skipOptimisation: true, fileType: undefined }));
  assert.equal(text.result.issues, undefined, JSON.stringify(text.result.issues));
  assert.ok(named(text.settings, 'Text renamed').skipOptimisation);
  assert.ok(run(start, save({ id: 'OLD2', base: second.revision, name: 'Text', text: second.text.replace('2', '3'), fileType: undefined })).result.issues!.length > 0, 'a changed value is checked again');
  // A rename to a name within the limits works while the step keeps its stored value.
  const renamed = run(start, save({ id: 'OLD', base, name: 'Short', details: longDetails, icon: oddIcon, view: 'json', text: json }));
  assert.equal(renamed.result.issues, undefined);
  assert.equal(named(renamed.settings, 'Short').id, 'OLD');
  // Changing the value to another bad one, or any label to a new over-long one, is refused with a clear message.
  assert.ok(run(start, save({ id: 'OLD', base, name: longName, details: longDetails, icon: oddIcon, view: 'json', text: json.replace('0', '-1') })).result.issues!.length > 0);
  assert.match(run(start, save({ id: 'OLD', base, name: longName + 'x', details: longDetails, icon: oddIcon, view: 'json', text: json })).result.issues![0].message, /name can be at most 80 characters; this one has 101/);
  assert.match(run(start, save({ id: 'OLD', base, name: 'Short', details: longDetails + 'x', icon: oddIcon, view: 'json', text: json })).result.issues![0].message, /description can be at most 300/);
  assert.match(run(start, save({ id: 'OLD', base, name: 'Short', icon: 'bad icon', view: 'json', text: json })).result.issues![0].message, /icon name uses only letters/);
  assert.match(run(start, save({ name: longName })).result.issues![0].message, /name can be at most 80/);
  assert.match(run(start, save({ icon: '../etc' })).result.issues![0].message, /icon name uses only letters/);
  // The same for a preset zone: a stored long name and odd icon stay while the pipeline changes.
  const zone = editorState(start, windows).zones[0], zoneBase = zone.revision;
  const zoneName = (start.presetZones[0] as PresetZone).name;
  assert.equal(run(start, { type: 'zone-save', id: 'ZOLD', base: zoneBase, name: zoneName, icon: oddIcon, fileType: 'image', pipelineId: 'OLD' }).result.issues, undefined);
  assert.match(run(start, { type: 'zone-save', id: 'ZOLD', base: zoneBase, name: zoneName + 'x', icon: oddIcon, fileType: 'image' }).result.issues![0].message, /name can be at most 40/);
  assert.match(run(start, { type: 'zone-save', name: 'New', icon: 'a b' }).result.issues![0].message, /icon name uses only letters/);
});

test('an unreadable entry can be fixed with JSON that has comments and trailing commas, and with JSON longer than a pipeline text', () => {
  const start = fixture({ savedPipelines: [...fixture().savedPipelines, ...decodePipelines([{ id: 'NEW', name: 'From the future', steps: [{ teleport: {} }] }])!] });
  const entry = editorState(start, windows).library.at(-1)!;
  const jsonc = `{
    // fixed by hand
    "name": "Fixed", /* name */
    "steps": [{ "optimise": {} },],
  }`;
  const fixed = run(start, { type: 'pipeline-fix', key: entry.key, base: entry.revision, json: jsonc });
  assert.equal(fixed.result.issues, undefined, JSON.stringify(fixed.result.issues));
  assert.equal(named(fixed.settings, 'Fixed').id, 'NEW');
  const big = JSON.stringify({ name: 'Big', details: 'x'.repeat(LIMITS.text), steps: [{ optimise: {} }] }, null, 2);
  assert.ok(big.length > LIMITS.text);
  assert.equal(run(start, { type: 'pipeline-fix', key: entry.key, base: entry.revision, json: big }).result.issues, undefined);
  assert.throws(() => applyCommand(start, { type: 'pipeline-fix', key: entry.key, base: entry.revision, json: ' '.repeat(LIMITS.fix + 1) }, windows), /invalid pipeline JSON/);
});
