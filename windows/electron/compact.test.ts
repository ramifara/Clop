import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompactMode, cardsThatFit, extraHeight, type CompactRow, type Timers } from './compact';

/** A clock the test moves by hand. */
function clock() {
  let now = 0, next = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: Timers = { set: (callback, ms) => { pending.set(++next, { at: now + ms, callback }); return next; }, clear: handle => { pending.delete(handle as number); } };
  return { timers, pending: () => pending.size, advance(ms: number) { now += ms; for (const [id, timer] of [...pending]) if (timer.at <= now) { pending.delete(id); timer.callback(); } } };
}
const rows = (count: number, running = false): CompactRow[] => Array.from({ length: count }, (_, i) => ({ id: `r${i}`, running }));
function setup(over: { always?: boolean; seconds?: number; fit?: number; paused?: () => boolean } = {}) {
  const time = clock(), cleared: string[][] = [], switches: boolean[] = [], state = { always: over.always ?? false, seconds: over.seconds ?? 120, fit: over.fit ?? 5 };
  const mode = new CompactMode({ always: () => state.always, seconds: () => state.seconds, fit: () => state.fit, clear: ids => cleared.push(ids), paused: over.paused, switched: value => switches.push(value), timers: time.timers });
  return { mode, time, cleared, switches, state };
}

test('more results than fit switch to the compact list, which stays until every result is gone', () => {
  const { mode, switches } = setup();
  assert.equal(mode.update(rows(5)), false, 'five fit');
  assert.equal(mode.update(rows(6)), true);
  assert.equal(mode.update(rows(2)), true, 'fewer results do not bring the cards back');
  assert.equal(mode.update(rows(1)), true);
  assert.equal(mode.update([]), false, 'an empty shelf starts over');
  assert.equal(mode.update(rows(3)), false);
  assert.deepEqual(switches, [true, false]);
});

test('the number of cards that fit follows the screen and the drop target', () => {
  assert.equal(cardsThatFit(1040), 5);
  assert.equal(cardsThatFit(1040, true), 4);
  assert.equal(cardsThatFit(700), 3);
  assert.equal(cardsThatFit(700, true), 2);
  assert.equal(cardsThatFit(200, true), 1, 'always at least one');
  const { mode } = setup({ fit: cardsThatFit(700) });
  assert.equal(mode.update(rows(4)), true, 'four do not fit a short screen');
});

test('the cards that fit leave room for a notice and the welcome card', () => {
  const room = (extra: Parameters<typeof extraHeight>[0]) => cardsThatFit(1080, false, 170, 60 + extraHeight(extra));
  assert.equal(room({ notice: false, welcome: false }), 5);
  assert.equal(room({ notice: true, welcome: true }), 4);
  assert.equal(extraHeight({ notice: true, welcome: true }), 305);
});

test('alwaysShowCompactResults keeps the compact list, even with nothing to show', () => {
  const { mode, state } = setup({ always: true });
  assert.equal(mode.update(rows(1)), true);
  assert.equal(mode.update([]), true);
  state.always = false;
  assert.equal(mode.update([]), false);
  assert.equal(mode.update(rows(1)), false);
});

test('the compact list clears every result after the configured time once none is running', () => {
  const { mode, time, cleared, state } = setup({ always: true, seconds: 10 });
  mode.update(rows(3));
  time.advance(9_000);
  assert.deepEqual(cleared, []);
  time.advance(1_000);
  assert.deepEqual(cleared, [['r0', 'r1', 'r2']]);
  time.advance(60_000);
  assert.equal(cleared.length, 1, 'once');
  state.seconds = 0;
  mode.update(rows(2));
  assert.equal(time.pending(), 0, '0 means never');
});

test('a result still running holds the countdown, and a new or finished one starts it again', () => {
  const { mode, time, cleared } = setup({ always: true, seconds: 10 });
  mode.update([...rows(2), { id: 'busy', running: true }]);
  assert.equal(time.pending(), 0);
  time.advance(30_000);
  assert.deepEqual(cleared, []);
  mode.update([...rows(2), { id: 'busy', running: false }]);
  time.advance(6_000);
  mode.update([...rows(2), { id: 'busy', running: false }]);
  time.advance(4_000);
  assert.equal(cleared.length, 1, 'an unchanged set keeps its countdown');
  mode.update(rows(1));
  time.advance(6_000);
  mode.update([...rows(1), { id: 'new', running: false }]);
  time.advance(6_000);
  assert.equal(cleared.length, 1, 'a new result starts the countdown again');
  time.advance(4_000);
  assert.deepEqual(cleared.at(-1), ['r0', 'new']);
});

test('clearing waits while a result is hovered or selected, and the cards layout never clears', () => {
  const state = { hovered: true };
  const { mode, time, cleared } = setup({ always: true, seconds: 5, paused: () => state.hovered });
  mode.update(rows(2));
  time.advance(5_000);
  time.advance(4_000);
  assert.deepEqual(cleared, []);
  state.hovered = false;
  time.advance(1_000);
  assert.deepEqual(cleared, [['r0', 'r1']]);
  const cards = setup({ seconds: 5 });
  cards.mode.update(rows(2));
  cards.time.advance(60_000);
  assert.deepEqual(cards.cleared, [], 'the full cards hide one by one on their own timers');
});

test('leaving the compact layout, or disposing, stops the countdown', () => {
  const { mode, time, cleared } = setup({ seconds: 5 });
  mode.update(rows(6));
  assert.equal(time.pending(), 1);
  mode.update([]);
  assert.equal(time.pending(), 0);
  mode.update(rows(6));
  mode.dispose();
  time.advance(10_000);
  assert.deepEqual(cleared, []);
});
