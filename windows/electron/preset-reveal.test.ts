import assert from 'node:assert/strict';
import test from 'node:test';
import { PresetReveal, TAP_MAX_MS } from './preset-reveal';

const ctrl = { ctrl: true, other: false }, other = { ctrl: false, other: true }, none = { ctrl: false, other: false }, both = { ctrl: true, other: true };

test('by default holding Ctrl shows the zones, and a tap leaves them up until the next tap', () => {
  const reveal = new PresetReveal();
  reveal.update(ctrl, false, 0);
  assert.equal(reveal.revealed(false), true);
  reveal.update(none, false, TAP_MAX_MS + 1);
  assert.equal(reveal.revealed(false), false, 'a hold ends with the key');
  reveal.update(ctrl, false, 1000); reveal.update(none, false, 1100);
  assert.equal(reveal.revealed(false), true, 'a tap pins the zones');
  reveal.update(ctrl, false, 2000); reveal.update(none, false, 2100);
  assert.equal(reveal.revealed(false), false, 'the next tap hides them');
});

test('Alt and Shift do not show the zones: Alt belongs to the drop zone and Shift to aggressive optimisation', () => {
  const reveal = new PresetReveal();
  reveal.update(other, false, 0);
  assert.equal(reveal.revealed(false), false, 'held');
  reveal.update(none, false, 100);
  assert.equal(reveal.revealed(false), false, 'tapped');
});

test('with onlyShowPresetZonesOnControlTapped holding does nothing and a tap toggles the zones', () => {
  const reveal = new PresetReveal();
  reveal.update(ctrl, true, 0);
  assert.equal(reveal.revealed(true), false, 'the key being down shows nothing');
  reveal.update(none, true, TAP_MAX_MS + 1);
  assert.equal(reveal.revealed(true), false, 'a hold is not a tap');
  reveal.update(ctrl, true, 1000); reveal.update(none, true, 1100);
  assert.equal(reveal.revealed(true), true, 'a tap leaves the zones up after the key is released');
  reveal.update(ctrl, true, 2000);
  assert.equal(reveal.revealed(true), true);
  reveal.update(none, true, TAP_MAX_MS + 2001);
  assert.equal(reveal.revealed(true), true, 'holding does not hide them');
  reveal.update(ctrl, true, 3000); reveal.update(none, true, 3100);
  assert.equal(reveal.revealed(true), false, 'the next tap hides them');
});

test('Ctrl with Alt or Shift is not a tap, and a new drag starts with the zones hidden', () => {
  const reveal = new PresetReveal();
  reveal.update(ctrl, true, 0); reveal.update(both, true, 10); reveal.update(none, true, 20);
  assert.equal(reveal.revealed(true), false, 'another key joined');
  reveal.update(other, true, 50); reveal.update(both, true, 60); reveal.update(other, true, 90); reveal.update(none, true, 95);
  assert.equal(reveal.revealed(true), false, 'Ctrl pressed while another key was down');
  reveal.update(ctrl, true, 100); reveal.update(none, true, 150);
  assert.equal(reveal.revealed(true), true);
  reveal.reset();
  assert.equal(reveal.revealed(true), false);
});
