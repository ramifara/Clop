import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { seedBuiltinPipelines } from '../core/pipeline/builtins';
import { Unreadable, isReadable } from '../core/pipeline/codec';
import { pipelinesFor } from '../core/pipeline/triggers';
import { SettingsStore } from '../core/settings/store';
import { EditorService } from './editor';

async function setup(t: { after: (fn: () => Promise<void>) => void }, initial?: object) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-editor-')), file = path.join(dir, 'settings.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (initial) await writeFile(file, JSON.stringify(initial));
  const store = new SettingsStore(file, { home: dir, desktop: path.join(dir, 'Desktop'), userData: dir });
  await store.load();
  await store.set(seedBuiltinPipelines(store.get('savedPipelines'), 0));
  const editor = new EditorService({ settings: () => store.get(), change: patch => store.set(patch), context: () => ({ home: dir }) });
  const onDisk = async () => JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
  return { dir, file, store, editor, onDisk };
}
const draft = (over: object = {}) => ({ type: 'pipeline-save', name: 'Small', fileType: 'image', skipOptimisation: false, hideResult: false, view: 'text', text: 'downscale(factor: 0.5)', ...over });

test('a saved pipeline, its attachment and a preset zone reach the settings file and survive a restart', async t => {
  const { editor, store, file, dir } = await setup(t);
  const saved = await editor.command(draft());
  const id = saved.saved!;
  await editor.command({ type: 'attach', fileType: 'image', source: 'clipboard', pipelineId: id });
  await editor.command({ type: 'attach', fileType: 'image', source: 'dropZone', pipelineId: id });
  const reply = await editor.command({ type: 'zone-save', name: 'Half', icon: 'photo', fileType: 'image', pipelineId: id });
  assert.equal(reply.state.zones.length, 1);
  const reloaded = new SettingsStore(file, { home: dir, desktop: path.join(dir, 'Desktop'), userData: dir });
  const settings = await reloaded.load();
  assert.equal(settings.savedPipelines.filter(isReadable).find(p => p.id === id)?.rawText, 'downscale(factor: 0.5)');
  assert.deepEqual(pipelinesFor('image', 'clipboard', settings).map(p => p.id), [id]);
  assert.deepEqual(pipelinesFor('image', 'dropZone', settings).map(p => p.id), [id]);
  assert.equal(settings.presetZones.length, 1);
  assert.equal(editor.state().attachments.image[0].entries[0].name, 'Small');
});

test('commands from the window are applied one after the other, none lost', async t => {
  const { editor, store } = await setup(t);
  const before = store.get('savedPipelines').length;
  const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => editor.command(draft({ name: `P${i}`, text: `downscale(factor: 0.${i + 1})` }))));
  assert.equal(store.get('savedPipelines').length, before + 12);
  assert.equal(new Set(replies.map(reply => reply.saved)).size, 12);
  assert.equal(replies[11].state.library.length, before + 12, 'the last reply sees all of them');
});

test('a malformed command rejects and changes nothing; the next command still runs', async t => {
  const { editor, store, onDisk } = await setup(t);
  const before = JSON.stringify(await onDisk());
  for (const bad of [null, 'attach', { type: 'attach' }, draft({ name: '' }), draft({ view: 'rtf' }), { type: 'zone-move', key: 'a', to: -3 }, draft({ icon: '..\\x' })])
    await assert.rejects(editor.command(bad), /invalid/);
  assert.equal(JSON.stringify(await onDisk()), before);
  const reply = await editor.command(draft({ text: 'crop(widht: 5)' }));
  assert.equal(reply.issues?.length, 1);
  assert.equal(reply.saved, undefined);
  assert.equal(JSON.stringify(await onDisk()), before, 'what does not parse is not saved');
  assert.ok((await editor.command(draft())).saved);
});

test('an entry Windows cannot read is written back exactly as it was', async t => {
  const future = { id: 'FUTURE', name: 'Newer step', steps: [{ teleport: { to: 'moon' } }], futureKey: true };
  const macString = JSON.stringify({ id: 'MACSTR', name: 'Mac string', steps: [{ optimise: {} }, { somethingNew: {} }] });
  const { editor, onDisk } = await setup(t, { savedPipelines: [future, macString], pipelinesToRunOnImage: { clipboard: [future] }, presetZones: [{ id: 'ZN', name: 'Newer', icon: 'x', pipeline: future }] });
  assert.ok(editor.state().library.slice(0, 2).every(entry => !entry.readable));
  const saved = await editor.command(draft());
  await editor.command({ type: 'attach', fileType: 'image', source: 'clipboard', pipelineId: saved.saved });
  await editor.command({ type: 'zone-save', name: 'Half', icon: 'photo', fileType: 'image', pipelineId: saved.saved });
  const disk = await onDisk();
  assert.deepEqual(disk.savedPipelines.slice(0, 2), [future, macString], 'the object and the Defaults string are kept verbatim');
  assert.deepEqual(disk.pipelinesToRunOnImage.clipboard[0], future);
  assert.deepEqual(disk.presetZones[0], { id: 'ZN', name: 'Newer', icon: 'x', pipeline: future });
  assert.equal(disk.pipelinesToRunOnImage.clipboard.length, 2);
  const fixed = await editor.command({ type: 'pipeline-fix', key: 'unreadable:id:MACSTR', base: editor.state().library.find(entry => entry.key === 'unreadable:id:MACSTR')!.revision, json: JSON.stringify({ name: 'Fixed', steps: [{ optimise: {} }] }) });
  assert.equal(fixed.saved, 'MACSTR');
  assert.equal((await onDisk()).savedPipelines.some((entry: unknown) => entry instanceof Unreadable), false);
});
