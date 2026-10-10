import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClipboardPickup, type ClipboardChange } from './pickup';
function harness() {
  let now = 0, next = 0;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  const picked: number[] = [];
  const pickup = new ClipboardPickup(change => picked.push(change.sequence), 300, 30_000, {
    set: (callback, delay) => { scheduled.set(++next, { at: now + delay, callback }); return next; },
    clear: timer => { scheduled.delete(timer as number); },
    now: () => now,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...scheduled]) if (timer.at <= now) { scheduled.delete(id); timer.callback(); }
  };
  const image = (sequence: number, process: number, app = 'chrome'): ClipboardChange => ({ sequence, paths: [], image: true, process, app });
  return { pickup, picked, advance, image };
}
test('settles quick successive writes into a single pickup', () => {
  const { pickup, picked, advance, image } = harness();
  pickup.change(image(1, 10)); advance(100);
  pickup.change({ sequence: 2, paths: [], image: false, process: 10 }); advance(299);
  assert.deepEqual(picked, []);
  advance(1);
  assert.deepEqual(picked, [2]);
});
test('a known auto-copy editor waits until the user leaves it, then picks only the last version', () => {
  const { pickup, picked, advance, image } = harness();
  pickup.change(image(1, 20, 'snippingtool')); advance(5000);
  pickup.change(image(2, 20, 'snippingtool')); advance(60_000);
  pickup.change(image(3, 20, 'snippingtool')); advance(5000);
  pickup.focus(20);
  assert.deepEqual(picked, []);
  pickup.focus(30);
  assert.deepEqual(picked, [3]);
});
test('repeated image writes from an app that stays in front become an editing session', () => {
  const { pickup, picked, advance, image } = harness();
  pickup.change(image(1, 40, 'paint')); advance(2000);
  assert.deepEqual(picked, [1]);
  pickup.change(image(2, 40, 'paint')); advance(2000);
  pickup.change(image(3, 40, 'paint')); advance(2000);
  assert.deepEqual(picked, [1]);
  pickup.focus(50);
  assert.deepEqual(picked, [1, 3]);
});
test('copy, switch and copy again in the same app is never delayed', () => {
  const { pickup, picked, advance, image } = harness();
  pickup.change(image(1, 40)); advance(1000);
  pickup.focus(50); advance(1000); pickup.focus(40);
  pickup.change(image(2, 40)); advance(300);
  assert.deepEqual(picked, [1, 2]);
});
test('a text copy or a long pause ends the session', () => {
  const { pickup, picked, advance, image } = harness();
  pickup.change(image(1, 40)); advance(1000);
  pickup.change({ sequence: 2, paths: [], image: false, process: 40 }); advance(1000);
  pickup.change(image(3, 40)); advance(31_000);
  pickup.change(image(4, 40)); advance(300);
  assert.deepEqual(picked, [1, 2, 3, 4]);
});
test('changes without a known foreground app are picked up after settling', () => {
  const { pickup, picked, advance } = harness();
  pickup.change({ sequence: 1, paths: [], image: true }); advance(300);
  pickup.change({ sequence: 2, paths: [], image: true }); advance(300);
  assert.deepEqual(picked, [1, 2]);
});
