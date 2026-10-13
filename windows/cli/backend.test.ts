import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { desktopFolder, registryDesktop } from './backend';

test('the headless command line finds the Desktop where Explorer keeps it, as the app does, OneDrive included', async () => {
  const printed = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Desktop\r\n\r\n';
  assert.equal(registryDesktop(printed, { USERPROFILE: 'C:\\Users\\me' }), 'C:\\Users\\me\\OneDrive\\Desktop');
  assert.equal(registryDesktop(printed, { userprofile: 'C:\\Users\\me' }), 'C:\\Users\\me\\OneDrive\\Desktop', 'variable names ignore case, as on Windows');
  assert.equal(registryDesktop(printed, {}), undefined, 'an unknown variable is no folder');
  assert.equal(registryDesktop('    Desktop    REG_SZ    D:\\Desk\r\n', {}), 'D:\\Desk');
  assert.equal(registryDesktop('ERROR: The system was unable to find the specified registry key or value.', {}), undefined);
  assert.equal(await desktopFolder(os.homedir(), 'win32', async () => '    Desktop    REG_SZ    D:\\Desk\r\n'), 'D:\\Desk');
  assert.equal(await desktopFolder('C:\\Users\\me', 'win32', async () => '    Desktop    REG_SZ    D:\\Desk\r\n'), path.join('C:\\Users\\me', 'Desktop'), 'another home than the signed-in user\'s keeps its own Desktop');
  assert.equal(await desktopFolder('/home/me', 'win32', async () => { throw new Error('no reg.exe'); }), path.join('/home/me', 'Desktop'));
});
