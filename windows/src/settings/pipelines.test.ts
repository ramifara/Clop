import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PIPELINE_SOURCE_KEYS_FOR_UI, pipelineLabel, type PipelineLike } from './pipelines';
import { PIPELINE_SOURCE_KEYS } from '../../core/pipeline/triggers';

test('a pipeline is named by its name, else by the first line of its text', () => {
  assert.equal(pipelineLabel({ id: 'a', name: '  Social ' }), 'Social');
  assert.equal(pipelineLabel({ id: 'a', rawText: 'optimise\ndownscale 50%' }), 'optimise');
  assert.equal(pipelineLabel({ id: 'a', rawText: 'x'.repeat(100) }).length, 60);
  assert.equal(pipelineLabel({ id: 'a' }), 'Pipeline');
});

test('a reference to a saved pipeline reads as the saved one, and an unreadable pipeline says so', () => {
  const saved: PipelineLike[] = [{ id: 'lib', name: 'Web ready' }, { reason: 'unknown step', raw: {} }];
  assert.equal(pipelineLabel({ id: 'ref', libraryID: 'lib' }, saved), 'Web ready');
  assert.equal(pipelineLabel({ id: 'ref', libraryID: 'gone', name: 'Kept' }, saved), 'Kept');
  assert.equal(pipelineLabel({ reason: 'unknown step', raw: {} }), 'Unreadable pipeline');
  // What the main process sends for an `Unreadable` entry after crossing the process boundary.
  assert.equal(pipelineLabel(JSON.parse(JSON.stringify({ raw: { x: 1 }, reason: 'bad' })) as PipelineLike), 'Unreadable pipeline');
});

test('the window reads the same settings per file type as the pipeline runner', () => {
  assert.deepEqual(PIPELINE_SOURCE_KEYS_FOR_UI, PIPELINE_SOURCE_KEYS);
});
