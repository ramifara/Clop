import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog, type WatchdogAction } from './watchdog';

const kinds = (actions: WatchdogAction[]) => actions.map(action => action.kind);

test('a window that stops responding is logged and offered a reload once, and the offer goes away when it recovers', () => {
  const dog = new Watchdog();
  assert.deepEqual(kinds(dog.unresponsive('settings', 1000)), ['log', 'offer-reload']);
  assert.deepEqual(dog.unresponsive('settings', 2000), [], 'the same hang is not offered twice');
  assert.deepEqual(dog.responsive('settings', 6000), [
    { kind: 'log', level: 'info', text: 'The settings window responds again after 5000 ms.' },
    { kind: 'withdraw-offer', window: 'settings' },
  ]);
  assert.deepEqual(dog.responsive('settings', 7000), [], 'nothing to say about a window that was never hung');
});

test('windows hang independently', () => {
  const dog = new Watchdog();
  dog.unresponsive('settings', 0);
  assert.deepEqual(kinds(dog.unresponsive('batch', 10)), ['log', 'offer-reload']);
  assert.deepEqual(kinds(dog.responsive('settings', 20)), ['log', 'withdraw-offer']);
  assert.deepEqual(kinds(dog.responsive('batch', 30)), ['log', 'withdraw-offer']);
});

test('after the user chooses to wait, the same window is logged but not offered again until the cooldown passes', () => {
  const dog = new Watchdog({ cooldownMs: 60_000 });
  dog.unresponsive('floating', 0);
  dog.declined('floating', 5000);
  dog.responsive('floating', 9000);
  assert.deepEqual(kinds(dog.unresponsive('floating', 20_000)), ['log']);
  // Recovering from a hang that was never offered has no offer to withdraw.
  assert.deepEqual(kinds(dog.responsive('floating', 21_000)), ['log']);
  assert.deepEqual(kinds(dog.unresponsive('floating', 70_000)), ['log', 'offer-reload']);
  assert.deepEqual(kinds(dog.unresponsive('other', 20_000)), ['log', 'offer-reload']);
});

test('a window that hangs again within the cooldown and stays hung is offered a reload when the cooldown ends', () => {
  const dog = new Watchdog({ cooldownMs: 60_000, intervalMs: 500 });
  dog.unresponsive('floating', 0);
  dog.declined('floating', 5000);
  dog.responsive('floating', 9000);
  assert.deepEqual(kinds(dog.unresponsive('floating', 20_000)), ['log'], 'inside the cooldown: not offered');
  // The ticks are on time, so only offers show.
  const tick = (at: number) => { for (let t = (tick.at ?? 20_000) + 500; t < at; t += 500) dog.sample(t); tick.at = at; return dog.sample(at); };
  tick.at = undefined as number | undefined;
  assert.deepEqual(tick(30_000), [], 'still inside it');
  assert.deepEqual(tick(64_500), [], 'a window waited on at 5 s is offered again from 65 s');
  assert.deepEqual(tick(65_000), [{ kind: 'offer-reload', window: 'floating' }]);
  assert.deepEqual(tick(65_500), [], 'once');
  // Recovering withdraws that offer.
  assert.deepEqual(kinds(dog.responsive('floating', 66_000)), ['log', 'withdraw-offer']);
  // A window that was offered and is still waiting for an answer is not offered twice.
  dog.unresponsive('crop', 0);
  assert.deepEqual(dog.sample(200_000).filter(action => action.kind === 'offer-reload'), [], 'the first offer is the one that was already made');
});

test('a window that was reloaded or closed starts fresh', () => {
  const dog = new Watchdog();
  dog.unresponsive('crop', 0);
  dog.declined('crop', 100);
  dog.closed('crop');
  assert.deepEqual(kinds(dog.unresponsive('crop', 200)), ['log', 'offer-reload']);
});

test('a late timer tick means the main process was blocked; short delays, the first tick and a long stall do not spam the log', () => {
  const dog = new Watchdog({ intervalMs: 500, lagMs: 2000, logEveryMs: 10_000 });
  assert.deepEqual(dog.sample(0), [], 'the first tick only starts the clock');
  assert.deepEqual(dog.sample(500), []);
  assert.deepEqual(dog.sample(1100), [], 'a slightly late tick is normal');
  assert.deepEqual(dog.sample(1600), []);
  assert.deepEqual(dog.sample(6600), [{ kind: 'log', level: 'warn', text: 'The main process was blocked for about 4.5 s.' }]);
  assert.deepEqual(dog.sample(12_100), [], 'logged moments ago');
  assert.deepEqual(kinds(dog.sample(17_000)), ['log'], 'a later stall logs again');
});

test('waking from sleep is not a blocked main process', () => {
  const dog = new Watchdog({ intervalMs: 500, lagMs: 2000 });
  dog.sample(0);
  dog.resume();
  assert.deepEqual(dog.sample(8 * 3600 * 1000), [], 'the first tick after waking only restarts the clock');
  assert.deepEqual(dog.sample(8 * 3600 * 1000 + 500), []);
  assert.deepEqual(kinds(dog.sample(8 * 3600 * 1000 + 5500)), ['log'], 'a real stall after waking is still seen');
});
