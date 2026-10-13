import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plural, reopenQuestion } from './batch-text';

test('opening the previous batch names what it replaces: prepared files, or the finished batch when there are none', () => {
  assert.equal(plural(1, 'prepared file'), '1 prepared file');
  assert.equal(reopenQuestion(3).title, 'Open the previous batch and drop the 3 prepared files?');
  const none = reopenQuestion(0);
  assert.equal(none.title, 'Open the previous batch?');
  assert.doesNotMatch(none.title + none.text, /0 prepared|you prepared/);
  assert.match(none.text, /can still be reverted/);
});
