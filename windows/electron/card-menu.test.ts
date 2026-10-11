import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemMenu, type CardItem, type Invocation, type MenuNode } from '../core/cards/actions';
import { menuTemplate } from './card-menu';

const item: CardItem = { kind: 'image', status: 'ready', format: 'png', animated: false, options: { mode: 'balanced', scale: 1, format: 'auto' } };

test('a menu model becomes a native template whose clicks hand back the entry\'s action', () => {
  const clicked: Invocation[] = [];
  const nodes: MenuNode[] = [
    { separator: true }, { label: 'Dismiss', invoke: { action: 'dismiss' }, hint: 'Delete' }, { separator: true }, { separator: true }, { header: 'Transform' },
    { label: 'Downscale', submenu: [{ label: '50%', invoke: { action: 'downscale', arg: 0.5 }, checked: true }, { label: 'Off', invoke: { action: 'downscale', arg: 0.1 }, enabled: false }] },
    { label: 'Pipeline', invoke: { action: 'pipeline', arg: 'P' }, hint: 'a long pipeline text' }, { label: 'Nothing here' }, { separator: true },
  ];
  const template = menuTemplate(nodes, invocation => clicked.push(invocation));
  assert.deepEqual(template.map(entry => entry.type === 'separator' ? '-' : entry.label), ['Dismiss', '-', 'Transform', 'Downscale', 'Pipeline', 'Nothing here'], 'no leading, doubled or trailing separators');
  assert.deepEqual([template[0].accelerator, template[0].registerAccelerator, template[4].accelerator], ['Delete', false, undefined], 'a key hint is shown, long text is not');
  assert.equal(template[2].enabled, false, 'a header cannot be clicked');
  assert.equal(template[5].enabled, false, 'an entry with no action does nothing');
  const sub = template[3].submenu as Electron.MenuItemConstructorOptions[];
  assert.deepEqual([sub[0].type, sub[0].checked, sub[1].enabled], ['checkbox', true, false]);
  (template[0].click as () => void)(); (sub[0].click as () => void)();
  assert.deepEqual(clicked, [{ action: 'dismiss' }, { action: 'downscale', arg: 0.5 }]);
});

test('a real image menu converts without losing any action', () => {
  const nodes = itemMenu(item, { native: true, editor: 'GIMP', pipelines: [{ id: 'P', name: 'To WebP' }] });
  const count = (list: MenuNode[]): number => list.reduce((n, node) => n + ('invoke' in node && node.invoke ? 1 : 0) + ('submenu' in node && node.submenu ? count(node.submenu) : 0), 0);
  const seen: Invocation[] = [];
  const walk = (list: Electron.MenuItemConstructorOptions[]) => { for (const entry of list) { if (entry.click) (entry.click as () => void)(); if (entry.submenu) walk(entry.submenu as Electron.MenuItemConstructorOptions[]); } };
  walk(menuTemplate(nodes, invocation => seen.push(invocation)));
  assert.equal(seen.length, count(nodes));
  assert.ok(seen.some(i => i.action === 'editWith') && seen.some(i => i.action === 'pipeline' && i.arg === 'P'));
});
