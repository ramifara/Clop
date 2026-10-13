import assert from 'node:assert/strict';
import test from 'node:test';
import { loginExecutable, syncLoginItem } from './login-item';

function fake(openAtLogin: boolean) {
  const set: unknown[] = [];
  return { set, getLoginItemSettings: () => ({ openAtLogin }), setLoginItemSettings: (value: unknown) => { set.push(value); } };
}

test('the login item follows the stored setting when the app starts, and is left alone when it already does', () => {
  const off = fake(false);
  assert.equal(syncLoginItem(off, true, 'C:\\Clop.exe', true), true);
  assert.deepEqual(off.set, [{ openAtLogin: true, path: 'C:\\Clop.exe', args: ['--hidden'] }]);
  const on = fake(true);
  assert.equal(syncLoginItem(on, true, 'C:\\Clop.exe', true), false);
  assert.equal(syncLoginItem(on, false, 'C:\\Clop.exe', true), true);
  assert.deepEqual(on.set, [{ openAtLogin: false, path: 'C:\\Clop.exe', args: ['--hidden'] }]);
  const changed = fake(true);
  syncLoginItem(changed, true, 'C:\\Clop.exe');
  assert.equal(changed.set.length, 1, 'a settings change in the app always writes');
});

test('the portable app registers its launcher, not the temporary copy it runs from', () => {
  assert.equal(loginExecutable({ PORTABLE_EXECUTABLE_FILE: 'C:\\Tools\\Clop-portable.exe' }, 'C:\\Temp\\abc\\Clop.exe'), 'C:\\Tools\\Clop-portable.exe');
  assert.equal(loginExecutable({}, 'C:\\Program Files\\Clop\\Clop.exe'), 'C:\\Program Files\\Clop\\Clop.exe');
  assert.equal(loginExecutable({ PORTABLE_EXECUTABLE_FILE: '' }, 'C:\\Clop.exe'), 'C:\\Clop.exe');
});
