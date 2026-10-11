import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { verbPlan } from '../core/shell-verbs';
import { installVerbs, removeVerbs, verbsInstalled, type ExplorerHost } from './explorer';

const paths = { clop: 'C:\\Apps\\cli\\clop.exe', app: 'C:\\Apps\\Clop for Windows.exe' };
const plan = verbPlan(paths);

/** A registry in memory: `reg add` and `reg delete` as the real tool applies them, so the test sees what is left. */
function fakeHost(platform: NodeJS.Platform = 'win32', failOn?: string) {
  const keys = new Map<string, string>(), files = new Set<string>(), calls: string[][] = [];
  const host: ExplorerHost = {
    platform, sendToDir: () => 'C:\\SendTo',
    async reg(args) {
      calls.push(args);
      const [verb, key] = args, bare = key.replace(/^HKCU\\/, '');
      if (verb === 'add') { if (failOn && bare.endsWith(failOn)) return 1; keys.set(`${bare}|${args[2] === '/ve' ? '' : args[3]}`, args[args.indexOf('/d') + 1]); return 0; }
      if (verb === 'delete') { const found = [...keys.keys()].filter(entry => entry.startsWith(`${bare}|`) || entry.startsWith(`${bare}\\`)); for (const entry of found) keys.delete(entry); return found.length ? 0 : 1; }
      return [...keys.keys()].some(entry => entry.startsWith(`${bare}|`)) ? 0 : 1;
    },
    async shortcut(file) { files.add(file); },
    async remove(file) { files.delete(file); },
  };
  return { host, keys, files, calls };
}

test('installing writes every value of the plan and the Send To shortcut; removing leaves nothing behind', async () => {
  const { host, keys, files } = fakeHost();
  assert.equal(await verbsInstalled(paths, host), false);
  await installVerbs(paths, host);
  assert.equal(keys.size, plan.values.length);
  for (const value of plan.values) assert.equal(keys.get(`${value.key}|${value.name}`), value.value);
  assert.deepEqual([...files], [path.join('C:\\SendTo', 'Optimise with Clop.lnk')]);
  assert.equal(await verbsInstalled(paths, host), true);
  // Installing again replaces rather than duplicates.
  await installVerbs(paths, host);
  assert.equal(keys.size, plan.values.length);
  await removeVerbs(paths, host);
  assert.equal(keys.size, 0);
  assert.equal(files.size, 0);
  assert.equal(await verbsInstalled(paths, host), false);
});

test('removing touches only the verb keys, and a missing key is fine', async () => {
  const { host, calls } = fakeHost();
  await removeVerbs(paths, host);
  assert.deepEqual(calls.filter(args => args[0] !== 'delete'), []);
  assert.deepEqual(calls.map(args => args[1]).sort(), plan.roots.map(root => `HKCU\\${root}`).sort());
  assert.ok(calls.every(args => args.at(-1) === '/f'));
});

test('a write that fails removes what was written and says which key', async () => {
  const { host, keys, files } = fakeHost('win32', 'Clop.StripExif\\command');
  await assert.rejects(installVerbs(paths, host), /Clop\.StripExif\\command \(exit 1\)/);
  assert.equal(keys.size, 0);
  assert.equal(files.size, 0);
});

test('nothing reaches reg.exe off Windows', async () => {
  const { host, calls } = fakeHost('linux');
  await assert.rejects(installVerbs(paths, host), /need Windows/);
  await assert.rejects(removeVerbs(paths, host), /need Windows/);
  assert.equal(await verbsInstalled(paths, host), false);
  assert.deepEqual(calls, []);
});
