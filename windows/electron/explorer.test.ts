import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { verbPlan } from '../core/shell-verbs';
import { installVerbs, removeVerbs, verbsStatus, type ExplorerHost } from './explorer';

const paths = { app: 'C:\\Apps\\Clop-Windows-0.2.0-x64-Portable.exe' };
const plan = verbPlan(paths);

/** A registry in memory: `reg add` and `reg delete` as the real tool applies them, so the test sees what is left. */
function fakeHost(platform: NodeJS.Platform = 'win32', failOn?: string) {
  const keys = new Map<string, string>(), files = new Set<string>(), calls: string[][] = [];
  const host: ExplorerHost = {
    platform, sendToDir: () => 'C:\\SendTo',
    async reg(args) {
      calls.push(args);
      const [verb, key] = args, bare = key.replace(/^HKCU\\/, '');
      if (verb === 'add') { if (failOn && bare.endsWith(failOn)) return { code: 1, stdout: '' }; keys.set(`${bare}|${args[2] === '/ve' ? '' : args[3]}`, args[args.indexOf('/d') + 1]); return { code: 0, stdout: '' }; }
      if (verb === 'delete') { const found = [...keys.keys()].filter(entry => entry.startsWith(`${bare}|`) || entry.startsWith(`${bare}\\`)); for (const entry of found) keys.delete(entry); return { code: found.length ? 0 : 1, stdout: '' }; }
      const value = keys.get(`${bare}|`);
      return value === undefined ? { code: 1, stdout: 'ERROR: The system was unable to find the specified registry key or value.' } : { code: 0, stdout: `\r\nHKEY_CURRENT_USER\\${bare}\r\n    (Default)    REG_SZ    ${value}\r\n\r\n` };
    },
    async shortcut(file) { files.add(file); },
    async remove(file) { files.delete(file); },
  };
  return { host, keys, files, calls };
}

test('installing writes every value of the plan and the Send To shortcut; removing leaves nothing behind', async () => {
  const { host, keys, files } = fakeHost();
  assert.equal(await verbsStatus(paths, host), 'none');
  await installVerbs(paths, host);
  assert.equal(keys.size, plan.values.length);
  for (const value of plan.values) assert.equal(keys.get(`${value.key}|${value.name}`), value.value);
  assert.deepEqual([...files], [path.join('C:\\SendTo', 'Optimise with Clop.lnk')]);
  assert.equal(await verbsStatus(paths, host), 'current');
  // Installing again replaces rather than duplicates.
  await installVerbs(paths, host);
  assert.equal(keys.size, plan.values.length);
  await removeVerbs(paths, host);
  assert.equal(keys.size, 0);
  assert.equal(files.size, 0);
  assert.equal(await verbsStatus(paths, host), 'none');
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
  assert.equal(await verbsStatus(paths, host), 'none');
  assert.deepEqual(calls, []);
});

test('entries of the same exe that moved are told from the installer\'s, which the portable app does not take for its own', async () => {
  const { host } = fakeHost();
  const old = { app: 'D:\\Old place\\Clop-Windows-0.2.0-x64-Portable.exe' }, installed = { app: 'C:\\Program Files\\Clop for Windows\\Clop for Windows.exe' };
  await installVerbs(old, host);
  assert.equal(await verbsStatus(paths, host), 'moved');
  assert.equal(await verbsStatus(old, host), 'current');
  await installVerbs(installed, host);
  assert.equal(await verbsStatus(paths, host), 'none', 'another copy\'s entries are not ours, moved or current');
  await installVerbs(paths, host);
  assert.equal(await verbsStatus(paths, host), 'current');
});

test('a newer portable build takes over the entries of the one before it, and the installer\'s are still left alone', async () => {
  const { host } = fakeHost();
  const previous = { app: 'D:\\Tools\\Clop-Windows-0.1.1-x64-Portable.exe' };
  await installVerbs(previous, host);
  assert.equal(await verbsStatus(paths, host), 'moved', 'the version in the file name does not make it another app');
  assert.equal(await verbsStatus({ app: 'C:\\Apps\\Other-Portable.exe' }, host), 'none');
});

test('a portable app under a non-ASCII path is told from the way reg.exe prints it, so its entries are not rewritten at every start', async () => {
  const { host, keys } = fakeHost();
  const jose = { app: 'C:\\Users\\Jos\u00e9\\Clop-Windows-0.2.0-x64-Portable.exe' };
  await installVerbs(jose, host);
  // What reg.exe's OEM-coded output looks like once decoded as UTF-8.
  for (const [key, value] of keys) keys.set(key, value.replace('Jos\u00e9', 'Jos\ufffd'));
  assert.equal(await verbsStatus(jose, host), 'current');
});
