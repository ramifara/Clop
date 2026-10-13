import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEP_KINDS, kindForTextName, textName } from './model';
import { parsePipelineText } from './parser';
import { COMPACT_PIPELINE_REFERENCE, PIPELINE_REFERENCE, pipelinePrompt } from './reference';

/** Pipelines quoted in the text: inline code that starts with a step, and the steps argument of `clop pipeline` commands. */
function examples(text: string) {
  const code = [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]);
  const commands = [...text.matchAll(/clop pipeline (?:attach|run|add(?: --file-type \w+)? '[^']+'|preset add '[^']+') '([^']+)'/g)].map(match => match[1]);
  // Signatures (`crop(width, height)`), placeholders (`<steps>`, `...`, `factor: N`) and snippets wrapped across lines are not pipelines.
  return [...code, ...commands].filter(snippet => kindForTextName(/^\w+/.exec(snippet)?.[0] ?? '') && !/[<…\n]|\.\.\.|: [A-Z]\)/.test(snippet) && !/^\w+(\([^:]*\))?$/.test(snippet));
}

test('every example pipeline in the reference parses', () => {
  for (const text of [PIPELINE_REFERENCE, COMPACT_PIPELINE_REFERENCE]) {
    const found = examples(text);
    assert.ok(found.length >= 10, `${found.length} examples`);
    for (const example of found) assert.deepEqual(parsePipelineText(example).issues, [], example);
  }
});

test('the reference documents every step', () => {
  for (const kind of STEP_KINDS) {
    for (const text of [PIPELINE_REFERENCE, COMPACT_PIPELINE_REFERENCE]) assert.match(text, new RegExp(`[\\s\`]${textName(kind)}[(\`\\s]`), `${textName(kind)} in ${text.slice(0, 30)}`);
  }
});

test('the prompt appends the task when there is one', () => {
  assert.equal(pipelinePrompt(), PIPELINE_REFERENCE);
  assert.equal(pipelinePrompt(undefined, true), COMPACT_PIPELINE_REFERENCE);
  assert.ok(pipelinePrompt('shrink screenshots', true).startsWith(COMPACT_PIPELINE_REFERENCE));
  assert.ok(pipelinePrompt('shrink screenshots').endsWith('\n\n---\n\n## Task\n\nshrink screenshots\n\nReturn ONE line: a bare pipeline string, or a full `clop pipeline add`/`attach` command if the request is to save or automate it.\n'));
  assert.doesNotMatch(PIPELINE_REFERENCE + COMPACT_PIPELINE_REFERENCE, /zsh|sips|Control-drag|\/Users\//);
});
