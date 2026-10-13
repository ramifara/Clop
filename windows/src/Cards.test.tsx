import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactElement } from 'react';
import { defaultSettings } from '../core/settings/schema';
import { findBy, mount } from './hook-harness';
import type { AppState, ItemResult } from './types';

(globalThis as { window?: unknown }).window = {};
const { ResultCard } = await import('./Cards');

const image = { id: 'a', kind: 'image', name: 'a.png', source: 'file', status: 'ready', originalBytes: 100, outputBytes: 50, originalWidth: 10, originalHeight: 10, width: 10, height: 10, format: 'png', originalPreview: '', preview: '', animated: false, createdAt: 0, options: { mode: 'balanced', scale: 1, format: 'auto' } } as ItemResult;
const state = { items: [image], settings: { ...defaultSettings(), floatingResultActions: ['downscale', 'compression'] }, native: true, platform: 'win32' } as AppState;
const card = () => mount(() => ResultCard({ item: image, state, run: async task => { await task(); }, onSelect: () => {}, onMenu: () => {} }), undefined);
const button = (tree: ReactElement, label: string) => findBy(tree, props => props['aria-label'] === label && typeof props.onClick === 'function')!.props as { onClick(event: { clientX: number; clientY: number }): void; onPointerDown?(event: { preventDefault(): void }): void };

test('the compression and downscale corner buttons of a full card open their panels', () => {
  const view = card();
  button(view.render(), 'Compression').onClick({ clientX: 0, clientY: 0 });
  assert.ok(findBy(view.render(), props => props.className === 'card-panel compression-panel'), 'compression opens its panel');
  const scale = card();
  const downscale = button(scale.render(), 'Downscale');
  downscale.onPointerDown!({ preventDefault() {} });
  assert.ok(findBy(scale.render(), props => String(props.className).includes('scale-panel')), 'downscale opens on press');
});
