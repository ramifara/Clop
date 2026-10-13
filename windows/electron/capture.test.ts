import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectFromCapture, type Protectable } from './capture';

const window = (destroyed = false) => { const log: boolean[] = []; return { log, window: { isDestroyed: () => destroyed, setContentProtection: (enable: boolean) => { log.push(enable); } } satisfies Protectable }; };

test('the floating window is hidden from captures unless the setting allows them', () => {
  const { log, window: floating } = window();
  protectFromCapture(floating, false); protectFromCapture(floating, true);
  assert.deepEqual(log, [true, false]);
});

test('a window that is gone or not made yet is left alone', () => {
  const gone = window(true);
  protectFromCapture(gone.window, false); protectFromCapture(undefined, false);
  assert.deepEqual(gone.log, []);
});
