import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acrylicSupported, DropBackdrop, parseDropRect, windowBackground, type BackdropWindow, type Rect } from './appearance';

const page = { pageWidth: 236, pageHeight: 400 };
import { defaultSettings, parseSettings, settingsSchema } from '../core/settings/schema';

test('appearance follows Windows by default and holds only system, light or dark', () => {
  assert.equal(defaultSettings().appearance, 'system');
  assert.equal(settingsSchema.appearance.windowsOnly, true);
  assert.equal(parseSettings({ appearance: 'dark' }).appearance, 'dark');
  assert.equal(parseSettings({ appearance: 'sepia' }).appearance, 'system');
});

test('a window starts in the background colour its theme paints, which theme.css uses too', () => {
  const css = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
  const backgrounds = [...css.matchAll(/--bg: (#[0-9a-f]{6});/g)].map(match => match[1]);
  assert.deepEqual(backgrounds, [windowBackground(false), windowBackground(true)]);
});

test('acrylic is Windows 11 22H2 and later only', () => {
  assert.equal(acrylicSupported('win32', '10.0.22621'), true);
  assert.equal(acrylicSupported('win32', '10.0.26100'), true);
  assert.equal(acrylicSupported('win32', '10.0.22000'), false);
  assert.equal(acrylicSupported('win32', '10.0.19045'), false);
  assert.equal(acrylicSupported('linux', '6.8.0'), false);
  assert.equal(acrylicSupported('win32', 'weird'), false);
});

test('the drop zone box from the renderer is whole pixels inside reason, or nothing', () => {
  assert.deepEqual(parseDropRect({ x: 19.6, y: 20, width: 196, height: 148.2, pageWidth: 236, pageHeight: 399.6 }), { x: 20, y: 20, width: 196, height: 148, ...page });
  assert.equal(parseDropRect(null), undefined);
  assert.equal(parseDropRect({ x: 0, y: 0, width: 0, height: 10, ...page }), undefined);
  assert.throws(() => parseDropRect({ x: 0, y: 0, width: 10, height: 10 }), /drop zone/, 'the page size is part of the box');
  for (const bad of ['box', 3, { x: -1, y: 0, width: 1, height: 1, ...page }, { x: 0, y: 0, width: Infinity, height: 1, ...page }, { x: 0, y: 0, width: 20_000, height: 1, ...page }, { x: '1', y: 0, width: 1, height: 1, ...page }]) assert.throws(() => parseDropRect(bad), /drop zone/, JSON.stringify(bad));
});

function fakes(start: Rect = { x: 1000, y: 500, width: 236, height: 400 }) {
  const log: string[] = [];
  const floating = { bounds: start, visible: true, top: true, isDestroyed: () => false, isVisible: () => floating.visible, getBounds: () => floating.bounds, isAlwaysOnTop: () => floating.top, moveTop: () => log.push('floating on top') };
  let made = 0;
  const create = (): BackdropWindow => {
    made++;
    let visible = false;
    return {
      isDestroyed: () => false, isVisible: () => visible, destroy: () => log.push('destroy'),
      setBounds: bounds => log.push(`bounds ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`), showInactive: () => { visible = true; log.push('show'); }, hide: () => { visible = false; log.push('hide'); },
      setAlwaysOnTop: flag => log.push(`top ${flag}`), setBackgroundMaterial: material => log.push(material), setContentProtection: enable => log.push(`protect ${enable}`),
    };
  };
  return { log, floating, backdrop: new DropBackdrop(floating, create), made: () => made };
}

test('the backdrop sits under the drop zone, below the floating window, and is made once', () => {
  const { log, backdrop, made } = fakes();
  backdrop.place(undefined);
  assert.equal(made(), 0, 'nothing is made before the zone shows');
  backdrop.protect(true);
  backdrop.place({ x: 20, y: 20, width: 196, height: 148, ...page });
  assert.deepEqual(log, ['protect true', 'bounds 1020,520 196x148', 'top true', 'show', 'acrylic', 'floating on top']);
  log.length = 0;
  backdrop.place({ x: 20, y: 30, width: 196, height: 148, ...page });
  assert.deepEqual(log, ['bounds 1020,530 196x148', 'top true'], 'a visible backdrop only moves');
  backdrop.place(undefined);
  assert.deepEqual(log.slice(-1), ['hide']);
  backdrop.place({ x: 20, y: 30, width: 196, height: 148, ...page });
  assert.equal(made(), 1);
  assert.deepEqual(log.slice(-3), ['show', 'acrylic', 'floating on top']);
});

test('the backdrop follows the floating window as it moves, hides with it and takes its always-on-top', () => {
  const { log, floating, backdrop } = fakes();
  backdrop.place({ x: 20, y: 20, width: 196, height: 148, ...page });
  log.length = 0;
  floating.bounds = { x: 0, y: 0, width: 236, height: 400 }; floating.top = false;
  backdrop.sync();
  assert.deepEqual(log, ['bounds 20,20 196x148', 'top false']);
  log.length = 0;
  floating.bounds = { x: 0, y: -170, width: 236, height: 570 };
  backdrop.sync();
  assert.deepEqual(log, [], 'a box measured in the page before a resize waits for the next one');
  backdrop.place({ x: 20, y: 190, width: 196, height: 148, pageWidth: 236, pageHeight: 570 });
  assert.deepEqual(log, ['bounds 20,20 196x148', 'top false']);
  floating.bounds = { x: 0, y: 0, width: 236, height: 400 };
  floating.visible = false;
  backdrop.sync();
  assert.deepEqual(log.slice(-1), ['hide']);
  log.length = 0;
  backdrop.sync();
  assert.deepEqual(log, [], 'a hidden backdrop is not hidden again');
});
