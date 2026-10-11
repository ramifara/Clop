import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../core/settings/schema';
import { CursorFollower, dropZoneShown, hideChanges, hideDelay } from './floating-results';

const timing = (more: Partial<ReturnType<typeof defaultSettings>> = {}) => ({ ...defaultSettings(), ...more });

test('results hide after the delay their source has, with the macOS defaults of 30 and 10 seconds', () => {
  assert.deepEqual([hideDelay(timing(), 'drop'), hideDelay(timing(), 'clipboard'), hideDelay(timing(), 'folder')], [30_000, 10_000, 30_000]);
  assert.equal(hideDelay(timing({ autoHideFloatingResults: false }), 'clipboard'), undefined);
  assert.deepEqual([hideDelay(timing({ autoHideFloatingResultsAfter: 5, autoHideClipboardResultAfter: 2 }), 'drop'), hideDelay(timing({ autoHideFloatingResultsAfter: 5, autoHideClipboardResultAfter: 2 }), 'clipboard')], [5000, 2000]);
});
test('-1 gives clipboard results the file delay and 0 means never', () => {
  assert.equal(hideDelay(timing({ autoHideClipboardResultAfter: -1, autoHideFloatingResultsAfter: 60 }), 'clipboard'), 60_000);
  assert.equal(hideDelay(timing({ autoHideClipboardResultAfter: 0 }), 'clipboard'), undefined);
  assert.equal(hideDelay(timing({ autoHideFloatingResultsAfter: 0 }), 'drop'), undefined);
  assert.equal(hideDelay(timing({ autoHideClipboardResultAfter: -1, autoHideFloatingResultsAfter: 0 }), 'clipboard'), undefined);
});

test('the results follow the cursor to another display after three looks, and not on a passing visit', () => {
  const follower = new CursorFollower(), look = (cursor: number, more: { active?: boolean; frozen?: boolean } = {}) => follower.tick({ cursor, current: 1, active: true, ...more });
  assert.deepEqual([look(2), look(2), look(2)], [undefined, undefined, 2]);
  // Back on the display they are on, or away again, starts the count over.
  assert.deepEqual([look(2), look(2), look(1), look(2), look(2), look(2)], [undefined, undefined, undefined, undefined, undefined, 2]);
  assert.deepEqual([look(2), look(2), look(3), look(2), look(2), look(2)], [undefined, undefined, undefined, undefined, undefined, 2]);
  // Without results on screen there is nothing to move.
  assert.deepEqual([look(2), look(2), look(2, { active: false }), look(2), look(2)], [undefined, undefined, undefined, undefined, undefined]);
});
test('a drag or held button freezes the count instead of resetting it', () => {
  const follower = new CursorFollower(), look = (more: { frozen?: boolean } = {}) => follower.tick({ cursor: 2, current: 1, active: true, ...more });
  assert.deepEqual([look(), look(), look({ frozen: true }), look({ frozen: true }), look()], [undefined, undefined, undefined, undefined, 2]);
});

test('with onlyShowDropZoneOnOption a dragged-over drop target needs Alt held; without a drag or the setting it does not', () => {
  const shown = (more: Partial<Parameters<typeof dropZoneShown>[0]>) => dropZoneShown({ expecting: true, dragging: true, onlyWithAlt: false, alt: false, ...more });
  assert.equal(shown({}), true, 'by default a drag shows it');
  assert.deepEqual([shown({ onlyWithAlt: true }), shown({ onlyWithAlt: true, alt: true })], [false, true]);
  assert.equal(shown({ onlyWithAlt: true, dragging: false }), true, 'the tray\'s Show latest results is no drag');
  assert.equal(shown({ expecting: false, alt: true }), false);
});

test('results hide on no timer while the floating results are switched off', () => {
  assert.equal(hideDelay(timing({ enableFloatingResults: false }), 'clipboard'), undefined);
  assert.equal(hideDelay(timing({ enableFloatingResults: false }), 'drop'), undefined);
  assert.equal(hideDelay(timing({ enableFloatingResults: true }), 'drop'), 30_000);
});

test('a change of the timing settings starts again only the hide timers whose delay changed, and stops those that are no longer wanted', () => {
  const shown = [{ id: 'a', source: 'drop' }, { id: 'b', source: 'clipboard' }, { id: 'c', source: 'drop' }];
  const running = new Map([['a', 30_000], ['b', 10_000], ['gone', 30_000]]);
  // Nothing changed: the timers keep counting, the result without one gets its own, and a timer of a result that is not shown stops.
  assert.deepEqual(hideChanges(shown, running, timing()), { start: ['c'], stop: ['gone'] });
  // A new delay for files restarts those timers only.
  assert.deepEqual(hideChanges(shown, running, timing({ autoHideFloatingResultsAfter: 5 })), { start: ['a', 'c'], stop: ['gone', 'a'] });
  // Auto-hide off, or the results off: every timer stops and none starts, so switching back on does not pick up an old countdown.
  for (const off of [{ autoHideFloatingResults: false }, { enableFloatingResults: false }]) assert.deepEqual(hideChanges(shown, running, timing(off)), { start: [], stop: ['gone', 'a', 'b'] });
  // Never (0 seconds) is a delay too.
  assert.deepEqual(hideChanges(shown, new Map([['a', 30_000]]), timing({ autoHideFloatingResultsAfter: 0, autoHideClipboardResultAfter: 0 })), { start: [], stop: ['a'] });
});
