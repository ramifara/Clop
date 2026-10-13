import assert from 'node:assert/strict';
import test from 'node:test';
import { PresetReveal, TAP_MAX_MS } from './preset-reveal';

const ctrl = { ctrl: true, alt: false }, alt = { ctrl: false, alt: true }, none = { ctrl: false, alt: false }, both = { ctrl: true, alt: true };

test('by default holding Ctrl or Alt shows the tiles, and a tap leaves them up until the next tap', () => {
  const reveal = new PresetReveal();
  reveal.update(ctrl, false, 0);
  assert.equal(reveal.revealed(false), true);
  reveal.update(none, false, TAP_MAX_MS + 1);
  assert.equal(reveal.revealed(false), false, 'a hold ends with the key');
  reveal.update(alt, false, 1000); reveal.update(none, false, 1100);
  assert.equal(reveal.revealed(false), true, 'a tap pins the tiles');
  reveal.update(ctrl, false, 2000); reveal.update(none, false, 2100);
  assert.equal(reveal.revealed(false), false, 'the next tap hides them');
});

test('with onlyShowPresetZonesOnControlTapped holding does nothing and a tap toggles the tiles', () => {
  const reveal = new PresetReveal();
  reveal.update(ctrl, true, 0);
  assert.equal(reveal.revealed(true), false, 'the key being down shows nothing');
  reveal.update(none, true, TAP_MAX_MS + 1);
  assert.equal(reveal.revealed(true), false, 'a hold is not a tap');
  reveal.update(ctrl, true, 1000); reveal.update(none, true, 1100);
  assert.equal(reveal.revealed(true), true, 'a tap leaves the tiles up after the key is released');
  reveal.update(ctrl, true, 2000);
  assert.equal(reveal.revealed(true), true);
  reveal.update(none, true, TAP_MAX_MS + 2001);
  assert.equal(reveal.revealed(true), true, 'holding does not hide them');
  reveal.update(alt, true, 3000); reveal.update(none, true, 3100);
  assert.equal(reveal.revealed(true), false, 'the next tap hides them');
});

test('both keys together are not a tap, and a new drag starts with the tiles hidden', () => {
  const reveal = new PresetReveal();
  reveal.update(ctrl, true, 0); reveal.update(both, true, 10); reveal.update(none, true, 20);
  assert.equal(reveal.revealed(true), false);
  reveal.update(ctrl, true, 100); reveal.update(none, true, 150);
  assert.equal(reveal.revealed(true), true);
  reveal.reset();
  assert.equal(reveal.revealed(true), false);
});
