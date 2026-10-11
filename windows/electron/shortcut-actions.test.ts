import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPause } from '../core/shortcuts';
import type { ItemResult } from '../src/types';
import { ShortcutRunner, type ShortcutHost } from './shortcut-actions';

const item = (id: string, extra: Partial<ItemResult> = {}): ItemResult => ({
  id, kind: 'image', name: `${id}.png`, source: 'drop', status: 'ready', originalBytes: 100, outputBytes: 50, originalWidth: 100, originalHeight: 100, width: 100, height: 100, format: 'png',
  originalPreview: '', preview: '', options: { mode: 'balanced', scale: 1, format: 'auto' }, animated: false, createdAt: 0, ...extra,
});
function setup(items: ItemResult[] = [], extra: Partial<ShortcutHost> = {}) {
  const calls: string[] = [], state = { items, paused: false, fresh: undefined as ItemResult | undefined };
  const host: ShortcutHost = {
    items: () => state.items, latestClipboard: () => undefined,
    run: async (id, invocation) => { calls.push(`run ${id} ${invocation.action}${invocation.arg === undefined ? '' : ` ${invocation.arg}`}`); },
    open: async (view, id) => { calls.push(`open ${view} ${id}`); },
    dismiss: async id => { calls.push(`dismiss ${id}`); },
    stop: ids => { calls.push(`stop ${ids.join(',')}`); },
    bringBack: () => { calls.push('bringBack'); },
    paused: () => state.paused, setPaused: async value => { state.paused = value; calls.push(`paused ${value}`); },
    optimiseClipboard: async aggressive => { calls.push(`clipboard ${aggressive ? 'aggressive' : 'plain'}`); },
    freshClipboard: async () => { calls.push('fresh clipboard'); return state.fresh; },
    bitrates: async () => [64, 128, 96, 192],
    inform: text => { calls.push(`inform ${text}`); },
    ...extra,
  };
  return { runner: new ShortcutRunner(host), calls, state };
}

test('a shortcut acts on the newest result and waits for it while it works, never moving to an older one', async () => {
  const { runner, calls } = setup([item('b', { status: 'processing' }), item('a')]);
  for (const kind of ['downscale', 'restore', 'preview', 'crop', 'speedUp', 'aggressive'] as const) await assert.rejects(runner.run({ kind }), /Wait for this result to finish first/, kind);
  assert.deepEqual(calls, []);
});

test('a failed newest result is named, not skipped', async () => {
  const { runner } = setup([item('b', { status: 'error', error: 'Stopped.' }), item('a')]);
  await assert.rejects(runner.run({ kind: 'restore' }), /failed \(Stopped\.\).*Dismiss it first/);
});

test('with a ready newest result, downscale and resize go to that result by the steps of the card menu', async () => {
  const { runner, calls } = setup([item('b'), item('a')]);
  await runner.run({ kind: 'resize', factor: 0.5 });
  await runner.run({ kind: 'downscale' });
  assert.deepEqual(calls, ['run b downscale 0.5', 'run b downscale 0.7'], 'an image goes on from its own scale, which this fake never changes');
});

test('a video steps down from where the last step left it, and a restore starts it over', async () => {
  const { runner, calls } = setup([item('v', { kind: 'video' })]);
  await runner.run({ kind: 'downscale' }); await runner.run({ kind: 'downscale' });
  runner.noted('v', { action: 'restore' });
  await runner.run({ kind: 'downscale' });
  assert.deepEqual(calls, ['run v downscale 0.7', 'run v downscale 0.4', 'run v downscale 0.7']);
});

test('a downscale chosen from the card menu is where the next shortcut step starts', async () => {
  const { runner, calls } = setup([item('v', { kind: 'video' })]);
  runner.noted('v', { action: 'downscale', arg: 0.4 });
  await runner.run({ kind: 'downscale' });
  assert.deepEqual(calls, ['run v downscale 0.3']);
});

test('a PDF steps its resolution down and refuses a resize key; audio steps its bitrate down', async () => {
  const pdf = setup([item('p', { kind: 'pdf' })]);
  await pdf.runner.run({ kind: 'downscale' }); await pdf.runner.run({ kind: 'downscale' });
  assert.deepEqual(pdf.calls, ['run p resolution 250', 'run p resolution 200']);
  await assert.rejects(pdf.runner.run({ kind: 'resize', factor: 0.5 }), /resolution/);
  const audio = setup([item('s', { kind: 'audio' })]);
  await audio.runner.run({ kind: 'downscale' }); await audio.runner.run({ kind: 'downscale' });
  assert.deepEqual(audio.calls, ['run s bitrate 128', 'run s bitrate 96']);
  await assert.rejects(audio.runner.run({ kind: 'resize', factor: 0.5 }), /no resolution/);
});

test('with no result, downscale works on the clipboard and speed-up does too, as on macOS', async () => {
  const { runner, calls, state } = setup([]);
  state.fresh = item('c', { source: 'clipboard' });
  await runner.run({ kind: 'resize', factor: 0.3 });
  state.fresh = item('m', { kind: 'video', source: 'clipboard' });
  await runner.run({ kind: 'speedUp' });
  assert.deepEqual(calls, ['fresh clipboard', 'run c downscale 0.3', 'fresh clipboard', 'run m speed 1.25']);
  state.fresh = item('i', { source: 'clipboard' });
  await assert.rejects(runner.run({ kind: 'speedUp' }), /Only videos and audio/);
});

test('"downscale and preview the clipboard" steps the result down and opens its preview; the shortcut does not open one', async () => {
  const { runner, calls, state } = setup([]);
  state.fresh = item('c', { source: 'clipboard' });
  await runner.downscaleClipboard(undefined, true);
  await runner.run({ kind: 'downscale' });
  assert.deepEqual(calls, ['fresh clipboard', 'run c downscale 0.7', 'open preview c', 'fresh clipboard', 'run c downscale 0.7']);
  const none = setup([]);
  await none.runner.downscaleClipboard(0.5, true);
  assert.deepEqual(none.calls, ['fresh clipboard'], 'nothing on the clipboard to work on');
});

test('preview opens the newest result, else the last clipboard result, else the clipboard', async () => {
  const shown = setup([item('b'), item('a')]);
  await shown.runner.run({ kind: 'preview' });
  assert.deepEqual(shown.calls, ['open preview b']);
  const old = setup([], { latestClipboard: () => item('old', { source: 'clipboard' }) });
  await old.runner.run({ kind: 'preview' });
  assert.deepEqual(old.calls, ['open preview old']);
  const fresh = setup([]); fresh.state.fresh = item('c');
  await fresh.runner.run({ kind: 'preview' });
  assert.deepEqual(fresh.calls, ['fresh clipboard', 'open preview c']);
});

test('keys that need a result say so when there is none', async () => {
  const { runner } = setup([]);
  for (const kind of ['crop', 'restore'] as const) await assert.rejects(runner.run({ kind }), /no result/, kind);
});

test('restore skips a result that is already original, and aggressive one that already is', async () => {
  const { runner, calls } = setup([item('a', { unchanged: true })]);
  await runner.run({ kind: 'restore' });
  const aggressive = setup([item('a', { options: { mode: 'aggressive', scale: 1, format: 'auto' } })]);
  await aggressive.runner.run({ kind: 'aggressive' });
  assert.deepEqual([...calls, ...aggressive.calls], []);
});

test('aggressive with no result optimises the clipboard; on a video it says it is not offered', async () => {
  const none = setup([]);
  await none.runner.run({ kind: 'aggressive' });
  assert.deepEqual(none.calls, ['clipboard aggressive']);
  await assert.rejects(setup([item('v', { kind: 'video' })]).runner.run({ kind: 'aggressive' }), /not offered for videos/);
});

test('escape stops and clears only the results in view', async () => {
  const { runner, calls } = setup([item('b'), item('a')]);
  await runner.run({ kind: 'clearAll' });
  assert.deepEqual(calls, ['stop b,a', 'dismiss b', 'dismiss a']);
});

test('backspace dismisses the newest result even while it works', async () => {
  const { runner, calls } = setup([item('b', { status: 'processing' }), item('a')]);
  await runner.run({ kind: 'dismiss' });
  assert.deepEqual(calls, ['dismiss b']);
});

test('the pause key cycles running, paused for the next clipboard event, stopped, running', async () => {
  const { runner, calls } = setup([]);
  await runner.run({ kind: 'pause' });
  await runner.run({ kind: 'pause' });
  await runner.run({ kind: 'pause' });
  await runner.run({ kind: 'pause' });
  assert.deepEqual(calls.filter(call => call.startsWith('paused')), ['paused true', 'paused false']);
  assert.deepEqual(calls.filter(call => call.startsWith('inform')).map(call => call.split('.')[0]), ['inform Paused', 'inform Stopped', 'inform Running', 'inform Paused']);
  assert.equal(runner.consumePauseNext(), true, 'the fourth press is waiting for the next clipboard event');
  assert.equal(runner.consumePauseNext(), false, 'which is used up by one event');
});

test('a pause change from anywhere else drops an armed "next clipboard event" pause', async () => {
  const { runner, state } = setup();
  await runner.run({ kind: 'pause' });
  // The tray or Settings pauses and resumes while the key's first press is still waiting.
  state.paused = true; runner.pauseChanged(); state.paused = false; runner.pauseChanged();
  assert.equal(runner.consumePauseNext(), false, 'the next copy is not ignored');
  await runner.run({ kind: 'pause' });
  assert.equal(runner.consumePauseNext(), true, 'the key arms it again');
});

test('the pause cycle as a pure step', () => {
  assert.deepEqual(nextPause({ paused: false, pauseNext: false }), { paused: false, pauseNext: true, notice: 'Paused. The next clipboard event will be ignored.' });
  assert.equal(nextPause({ paused: false, pauseNext: true }).paused, true);
  assert.deepEqual(nextPause({ paused: true, pauseNext: true }).pauseNext, false);
});
