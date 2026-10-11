import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../core/settings/schema';
import { CursorFollower, hideDelay } from './floating-results';

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
