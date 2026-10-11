import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineMenu } from './pipeline-menu';

const choices = [
  { id: 'a', name: 'Web size', text: 'crop(width: 1600)' },
  { id: 'b', name: 'GIF it', text: 'convert(to: gif)', fileType: 'video' as const },
  { id: 'c', name: 'Squash PDF', text: 'optimise', fileType: 'pdf' as const },
];

test('the menu lists the pipelines that work on at least one of the files, under the file count', () => {
  const picked: string[] = [];
  const menu = pipelineMenu(choices, ['image', 'video', undefined], 3, id => picked.push(id));
  assert.deepEqual(menu.map(item => item.label ?? item.type), ['Run on 3 files', 'separator', 'Web size', 'GIF it']);
  assert.equal(menu[0].enabled, false);
  (menu[3].click as () => void)();
  assert.deepEqual(picked, ['b']);
  assert.equal(pipelineMenu(choices, ['pdf'], 1, () => {})[0].label, 'Run on 1 file');
});

test('with nothing that fits, there is no menu to show', () => {
  assert.deepEqual(pipelineMenu(choices, ['audio'], 1, () => {}).map(item => item.label ?? item.type), ['Run on 1 file', 'separator', 'Web size']);
  assert.deepEqual(pipelineMenu([choices[1]], ['image'], 1, () => {}), []);
  assert.deepEqual(pipelineMenu([], ['image'], 1, () => {}), []);
});
