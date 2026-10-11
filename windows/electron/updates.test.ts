import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Updates, updateGate, type UpdateDriver, type UpdateEnv } from './updates';

const allowed: UpdateEnv & { beta: boolean } = { packaged: true, platform: 'win32', enabled: true, beta: false };

function setup(env: Partial<typeof allowed> = {}, answer: Awaited<ReturnType<UpdateDriver['checkForUpdates']>> | Error = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }) {
  const state = { ...allowed, ...env }, calls = { load: 0, check: 0, download: 0, install: 0 }, logs: string[] = [];
  const driver: UpdateDriver = {
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false, allowDowngrade: true,
    async checkForUpdates() { calls.check++; await new Promise(resolve => setTimeout(resolve, 5)); if (answer instanceof Error) throw answer; return answer; },
    async downloadUpdate() { calls.download++; },
    quitAndInstall() { calls.install++; },
  };
  const updates = new Updates({ env: () => state, load: async () => { calls.load++; return driver; }, version: '0.2.0', log: text => logs.push(text) });
  return { updates, state, calls, driver, logs };
}

test('the gate lets a check through only for a packaged Windows app with checking on', () => {
  assert.deepEqual(updateGate(allowed), { ok: true });
  assert.equal(updateGate({ ...allowed, packaged: false }).ok, false);
  assert.equal(updateGate({ ...allowed, platform: 'linux' }).ok, false);
  assert.equal(updateGate({ ...allowed, enabled: false }).ok, false);
  // Development wins over the setting, so the message names the real reason.
  assert.deepEqual(updateGate({ packaged: false, platform: 'linux', enabled: false }), { ok: false, why: 'development', message: 'Development builds do not check for updates.' });
});

test('a development or unpackaged run, another system, or a disabled setting never loads the updater or touches the network', async () => {
  for (const [env, why] of [[{ packaged: false }, 'development'], [{ platform: 'darwin' as const }, 'platform'], [{ enabled: false }, 'disabled']] as const) {
    const { updates, calls } = setup(env);
    const result = await updates.check();
    assert.equal(result.kind, 'skipped');
    assert.equal(result.kind === 'skipped' && result.why, why);
    await assert.rejects(updates.install());
    const stop = updates.schedule(() => assert.fail('no update can be found'), { first: 1, every: 1 });
    await new Promise(resolve => setTimeout(resolve, 30));
    stop();
    assert.deepEqual(calls, { load: 0, check: 0, download: 0, install: 0 }, JSON.stringify(env));
  }
});

test('turning checks off while Clop runs stops the next check', async () => {
  const { updates, state, calls } = setup();
  assert.equal((await updates.check()).kind, 'available');
  state.enabled = false;
  assert.equal((await updates.check()).kind, 'skipped');
  assert.equal(calls.check, 1);
});

test('a check only looks: nothing is downloaded or installed, and the channel follows the beta setting', async () => {
  const stable = setup();
  assert.deepEqual(await stable.updates.check(), { kind: 'available', version: '0.3.0' });
  assert.deepEqual(stable.calls, { load: 1, check: 1, download: 0, install: 0 });
  assert.equal(stable.driver.autoDownload, false);
  assert.equal(stable.driver.autoInstallOnAppQuit, false);
  assert.equal(stable.driver.allowDowngrade, false);
  assert.equal(stable.driver.allowPrerelease, false);
  const beta = setup({ beta: true });
  await beta.updates.check();
  assert.equal(beta.driver.allowPrerelease, true);
  beta.state.beta = false;
  await beta.updates.check();
  assert.equal(beta.driver.allowPrerelease, false, 'the channel is read at each check');
});

test('the result says current, available or failed, and a failure is logged in full but shown plainly', async () => {
  assert.deepEqual(await setup({}, { isUpdateAvailable: false, updateInfo: { version: '0.2.0' } }).updates.check(), { kind: 'current', version: '0.2.0' });
  assert.deepEqual(await setup({}, { updateInfo: { version: '0.2.0' } }).updates.check(), { kind: 'current', version: '0.2.0' });
  assert.deepEqual(await setup({}, null).updates.check(), { kind: 'current', version: '0.2.0' });
  const failing = setup({}, new Error('getaddrinfo ENOTFOUND api.github.com'));
  const result = await failing.updates.check();
  assert.equal(result.kind, 'error');
  assert.doesNotMatch(result.kind === 'error' ? result.message : '', /ENOTFOUND/);
  assert.match(failing.logs[0], /ENOTFOUND/);
});

test('checks that overlap share one request', async () => {
  const { updates, calls } = setup();
  const [a, b] = await Promise.all([updates.check(), updates.check()]);
  assert.deepEqual(a, b);
  assert.equal(calls.check, 1);
  await updates.check();
  assert.equal(calls.check, 2);
});

test('installing needs a found version, then downloads it and restarts into it', async () => {
  const { updates, calls } = setup();
  await assert.rejects(updates.install(), /Check for updates first/);
  await updates.check();
  await updates.install();
  assert.deepEqual(calls, { load: 1, check: 1, download: 1, install: 1 });
});

test('the schedule checks once after the first delay and again each interval, and reports new versions only', async () => {
  const { updates, calls } = setup();
  const found: string[] = [], timers: { run: () => void; delay: number }[] = [];
  const stop = updates.schedule(version => found.push(version), {
    first: 100, every: 1000,
    timers: { setTimeout: ((run: () => void, delay: number) => { const timer = { run, delay }; timers.push(timer); return timer as unknown as ReturnType<typeof setTimeout>; }) as never, clearTimeout: (() => {}) as never },
  });
  assert.deepEqual(timers.map(timer => timer.delay), [100]);
  timers[0].run();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(found, ['0.3.0']);
  assert.deepEqual(timers.map(timer => timer.delay), [100, 1000]);
  stop();
  timers[1].run();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.check, 2);
  assert.deepEqual(timers.map(timer => timer.delay), [100, 1000], 'stopped: no further timer');
});
