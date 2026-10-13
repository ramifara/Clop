import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { acceptAsCopy, aggressiveDrop, zonesKey } from './drag-keys';

const drag = (dropEffect: string, keys: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey', boolean>> = {}) => {
  let prevented = false;
  return { event: { shiftKey: false, ctrlKey: false, altKey: false, ...keys, preventDefault: () => { prevented = true; }, dataTransfer: { dropEffect, effectAllowed: 'all' } }, prevented: () => prevented };
};

test('a drag Clop takes is always a copy, so a Shift-drag from Explorer (a move) never has Explorer delete the source', () => {
  for (const [effect, keys] of [['move', { shiftKey: true }], ['link', { ctrlKey: true, shiftKey: true }], ['none', {}], ['copy', { ctrlKey: true }]] as const) {
    const { event, prevented } = drag(effect, keys);
    acceptAsCopy(event);
    assert.equal(event.dataTransfer.dropEffect, 'copy', `${effect} with ${JSON.stringify(keys)}`);
    assert.equal(prevented(), true, 'the drag is taken');
  }
  assert.doesNotThrow(() => acceptAsCopy({ preventDefault() {}, dataTransfer: null }));
});

test('Shift at the drop is aggressive and Ctrl shows the preset zones; neither means the other', () => {
  assert.equal(aggressiveDrop(drag('copy', { shiftKey: true }).event), true);
  assert.equal(aggressiveDrop(drag('copy', { ctrlKey: true }).event), false, 'Ctrl is not aggressive');
  assert.equal(zonesKey(drag('copy', { ctrlKey: true }).event), true);
  assert.equal(zonesKey(drag('copy', { shiftKey: true, altKey: true }).event), false, 'Shift and Alt do not show the zones');
});

test('every drop target in the windows names its effect through acceptAsCopy, and no drop reads Ctrl as aggressive', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path.join(dir, entry.name)] : []);
  const targets = files(path.resolve('src')).filter(file => /onDrop=/.test(readFileSync(file, 'utf8')));
  assert.ok(targets.length >= 2, 'the floating window and the batch window take drops');
  for (const file of targets) {
    const source = readFileSync(file, 'utf8'), name = path.relative('src', file);
    assert.doesNotMatch(source, /dropEffect\s*=/, `${name} sets a drop effect itself`);
    assert.match(source, /acceptAsCopy\(/, `${name} takes drops without acceptAsCopy`);
    assert.doesNotMatch(source, /import(Files|Url)\([^)]*ctrlKey/, `${name} reads Ctrl as aggressive`);
  }
});
