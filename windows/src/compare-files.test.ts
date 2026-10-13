import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvocation, planFor, type Invocation, type MenuNode } from '../core/cards/actions';
import { compareMenu, shortPath } from './compare-files';

const invocations = (nodes: MenuNode[]) => nodes.flatMap(node => 'label' in node && node.invoke ? [node.invoke] : []);
const labels = (nodes: MenuNode[]) => nodes.map(node => 'label' in node ? node.label : 'header' in node ? `# ${node.header}` : '-');

test('each side of the compare window has the macOS file actions: open, show in Explorer, copy the path', () => {
  assert.deepEqual(labels(compareMenu('result')), ['Open', 'Show in Explorer', 'Copy Path']);
  assert.deepEqual(invocations(compareMenu('result')), [{ action: 'openDefault' }, { action: 'reveal' }, { action: 'copyPath' }]);
  assert.deepEqual(invocations(compareMenu('original')), [{ action: 'openDefault', arg: 'original' }, { action: 'reveal', arg: 'original' }, { action: 'copyPath', arg: 'original' }]);
  assert.deepEqual(labels(compareMenu('both')), ['# Original', 'Open', 'Show in Explorer', 'Copy Path', '-', '# Optimised', 'Open', 'Show in Explorer', 'Copy Path']);
});

test('the file actions pass the card action table for every kind, and are carried out by the app', () => {
  for (const kind of ['image', 'video', 'pdf', 'audio'] as const) for (const invocation of invocations(compareMenu('both'))) {
    assert.deepEqual(parseInvocation(kind, invocation), invocation);
    const plan = planFor({ kind, options: { mode: 'balanced', scale: 1, format: 'auto' } }, invocation);
    assert.deepEqual(plan, { type: 'ui', ui: invocation.action, arg: invocation.arg });
  }
});

test('the table refuses a side it does not know, and the original for other actions', () => {
  const bad: Invocation[] = [{ action: 'reveal', arg: 'C:\\Windows\\System32' }, { action: 'copyPath', arg: 1 }, { action: 'openDefault', arg: 'result' }, { action: 'saveAs', arg: 'original' }, { action: 'copy', arg: 'original' }];
  for (const invocation of bad) assert.throws(() => parseInvocation('image', invocation), /does not take that value/, JSON.stringify(invocation));
});

test('a long path keeps its drive and file name, with the middle left out', () => {
  assert.equal(shortPath('C:\\Users\\me\\a.png'), 'C:\\Users\\me\\a.png');
  const long = `C:\\Users\\me\\${'Folder\\'.repeat(20)}holiday photo.png`, short = shortPath(long);
  assert.equal(short.length, 64);
  assert.ok(short.startsWith('C:\\Users\\') && short.endsWith('holiday photo.png') && short.includes('…'), short);
});
