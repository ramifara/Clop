import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import React from 'react';
import { defaultSettings, type ClopSettings } from '../../core/settings/schema';
import { find, findBy, mount } from '../hook-harness';

(globalThis as { window?: unknown }).window = {};
const { SettingsContext } = await import('./context');
const { Compression } = await import('./media');

test('picking a video encoder tier cancels a factor change that is still waiting to be saved', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const changes: Partial<ClopSettings>[] = [];
    const settings = { ...defaultSettings(), videoCompression: { tier: 'smaller', factor: 40 } } as ClopSettings;
    const context = { settings, change: (partial: Partial<ClopSettings>) => { changes.push(partial); } };
    // `Compression` is a function component: call it as React would.
    const hooked = mount(() => Compression({ settingKey: 'videoCompression' }), context);
    let tree = hooked.render();
    // The slider moves; before it is saved the user picks Adaptive.
    const slider = findBy(tree, props => props.type === 'range')!;
    (slider.props as { onChange(event: { target: { value: string } }): void }).onChange({ target: { value: '80' } });
    tree = hooked.render();
    (find(tree, 'Adaptive').props as { onClick(): void }).onClick();
    mock.timers.tick(1000);
    assert.deepEqual(changes, [{ videoCompression: { tier: 'adaptive', factor: 40 } }]);
  } finally { mock.timers.reset(); }
});
