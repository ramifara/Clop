import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { type ReactElement, type ReactNode } from 'react';
import { defaultSettings } from '../core/settings/schema';
import type { AppState, ItemResult } from './types';

const calls: string[] = [];
(globalThis as { window?: unknown }).window = { clop: { dismiss: async (id: string) => { calls.push(`dismiss ${id}`); }, cardAction: async (ids: string[], invocation: { action: string }) => { calls.push(`${invocation.action} ${ids}`); } } };
const { CompactList } = await import('./Compact');

const item = (status: ItemResult['status']) => ({ id: 'a', kind: 'image', name: 'a.png', source: 'file', status, originalBytes: 100, outputBytes: 50, originalWidth: 10, originalHeight: 10, width: 10, height: 10, format: 'png', originalPreview: '', preview: '', animated: false, createdAt: 0, options: { mode: 'balanced', scale: 1, format: 'auto' } }) as ItemResult;
function closeButton(node: ReactNode): ReactElement | undefined {
  if (Array.isArray(node)) return node.map(closeButton).find(Boolean);
  if (!React.isValidElement(node)) return undefined;
  const props = node.props as { className?: string; children?: ReactNode };
  return props.className === 'compact-close' ? node : closeButton(props.children);
}
async function press(status: ItemResult['status'], native: boolean) {
  calls.length = 0;
  const state = { items: [item(status)], settings: defaultSettings(), native, platform: 'win32' } as AppState;
  // `CompactList` keeps no state, so it is called as a function and its close button pressed.
  const tree = CompactList({ state, run: async task => { await task(); }, selection: [], onSelection: () => {}, onMenu: () => {}, onSelect: () => {} });
  (closeButton(tree)!.props as { onClick(event: { stopPropagation(): void }): void }).onClick({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  return [...calls];
}

test('the close button of a compact row that is processing stops it, and one that is done dismisses it', async () => {
  assert.deepEqual(await press('processing', true), ['stop a']);
  assert.deepEqual(await press('ready', true), ['dismiss a']);
  assert.deepEqual(await press('error', true), ['dismiss a']);
  // The browser preview cannot stop a job.
  assert.deepEqual(await press('processing', false), ['dismiss a']);
});

test('a card button for the cover art is offered only for an audio file that has some', async () => {
  const { cardButtons } = await import('./results');
  const settings = { ...defaultSettings(), compactResultActions: ['downscale'] };
  const buttons = (coverArt?: boolean) => cardButtons({ native: true, pipelines: [], settings }, { ...item('ready'), kind: 'audio', ...(coverArt === undefined ? {} : { coverArt }) }, true).map(button => button.label);
  assert.deepEqual(buttons(true), ['Downscale cover art']);
  assert.deepEqual(buttons(false), []);
});
