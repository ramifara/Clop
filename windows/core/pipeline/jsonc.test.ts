import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStep } from './model';
import { canFormat, parseSteps } from './parser';
import { parseJsoncSteps, stepsToJsonc, stripJsonc } from './jsonc';

test('comments and trailing commas are blanked out where they stand', () => {
  const text = '[\n  // note\n  {"a": "x // y", /* c */ "b": [1,],},\n]';
  const clean = stripJsonc(text);
  assert.equal(clean.length, text.length);
  assert.deepEqual(JSON.parse(clean), [{ a: 'x // y', b: [1] }]);
  assert.equal(clean.split('\n').length, text.split('\n').length, 'line breaks stay so positions hold');
});

test('the steps round-trip through the JSON view, each under its text form', () => {
  const steps = parseSteps('crop(width: 100) -> optimise(encoder: lossless) -> copy(to: "~/out")');
  const text = stepsToJsonc(steps);
  assert.match(text, /\/\/ crop\(width: 100\)\n/);
  const parsed = parseJsoncSteps(text);
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.steps, steps);
  assert.deepEqual(parseJsoncSteps(stepsToJsonc([])), { steps: [], issues: [] });
});

test('a step with no exact text form is flagged in the JSON view and survives the round trip', () => {
  const step = makeStep('runScript', { code: 'echo "a -> b"' });
  const steps = [step];
  const text = stepsToJsonc(steps);
  assert.deepEqual(parseJsoncSteps(text).steps, steps);
  assert.equal(canFormat(step), false);
  assert.match(text, /runScript: no exact text form/);
});

test('problems come back at their line and column, and the other steps still load', () => {
  const text = '[\n  {"optimise":{}},\n  {"teleport":{}},\n  {"crop":{"width":-5}}\n]';
  const { steps, issues } = parseJsoncSteps(text);
  assert.equal(steps.length, 1);
  assert.ok(issues.length >= 1 && issues.every(issue => issue.line !== undefined && issue.column !== undefined));
  assert.equal(issues[0].line, 3);
  assert.equal(issues[0].step, 1);
});

test('invalid JSON and a non-list report one positioned issue', () => {
  const broken = parseJsoncSteps('[\n  {"optimise": }\n]');
  assert.equal(broken.steps.length, 0);
  assert.equal(broken.issues.length, 1);
  assert.match(broken.issues[0].message, /^Not valid JSON/);
  assert.equal(broken.issues[0].line, 2);
  const object = parseJsoncSteps('{"optimise":{}}');
  assert.match(object.issues[0].message, /JSON list/);
});

test('steps that do not apply to the file type are reported', () => {
  const { steps, issues } = parseJsoncSteps('[{"removeAudio":{}}]', { fileType: 'image' });
  assert.equal(steps.length, 0);
  assert.equal(issues.length, 1);
});
