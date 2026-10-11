import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightSpans, highlightTokens, jsoncTokens } from './highlight';

const kinds = (text: string, fileType?: Parameters<typeof highlightTokens>[1]) => highlightTokens(text, fileType).map(token => `${token.type}:${text.slice(token.from, token.to)}`);

test('arrows, step names, parameter names and values get their own tokens', () => {
  assert.deepEqual(kinds('crop(width: 100) -> optimise'), ['step:crop', 'params:(width: 100)', 'param:width', 'value:100', 'arrow:->', 'step:optimise']);
});

test('an unknown step, or one that does not apply to the file type, is invalid', () => {
  assert.deepEqual(kinds('teleport(x: 1)'), ['invalid:teleport(x: 1)']);
  assert.deepEqual(kinds('removeAudio', 'image'), ['invalid:removeAudio']);
  assert.deepEqual(kinds('removeAudio', 'video'), ['step:removeAudio']);
});

test('a value outside the file type\'s suggestions is invalid', () => {
  assert.ok(kinds('optimise(encoder: fast)', 'video').includes('value:fast'));
  assert.ok(kinds('optimise(encoder: lossless)', 'video').includes('invalid:lossless'));
});

test('spans cover the whole text and carry the innermost token and the parser\'s error marks', () => {
  const text = 'crop(width: 100) -> zzz', spans = highlightSpans(text, highlightTokens(text), [{ offset: 20, length: 3 }]);
  assert.equal(spans.map(span => span.text).join(''), text);
  assert.deepEqual(spans.find(span => span.text === '100')?.type, 'value');
  const bad = spans.filter(span => span.error);
  assert.deepEqual([bad.map(span => span.text).join(''), bad[0].type], ['zzz', 'invalid']);
  assert.deepEqual(highlightSpans('', []), []);
});

test('the JSON view colours comments, keys and strings, and skips what looks like a comment inside a string', () => {
  const text = '[\n  // crop(width: 1)\n  {"crop": {"location": "http://a/b"}}, /* x */\n]';
  const shown = jsoncTokens(text).map(token => `${token.type}:${text.slice(token.from, token.to)}`);
  assert.deepEqual(shown, ['comment:// crop(width: 1)', 'param:"crop"', 'param:"location"', 'value:"http://a/b"', 'comment:/* x */']);
  assert.deepEqual(jsoncTokens('/* never closed'), [{ from: 0, to: 15, type: 'comment' }]);
  assert.deepEqual(jsoncTokens('"open string'), [{ from: 0, to: 12, type: 'value' }]);
});
