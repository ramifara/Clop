import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPathRefusal, isRemotePath, isRemoteTemplate, requireLocalDrive, requireNotRemote } from './local-path';

test('network shares and device paths are remote; drive paths, their long form and relative paths are local', () => {
  for (const remote of ['\\\\server\\share\\a.png', '//server/share/a.png', '\\/server/share', '\\\\?\\UNC\\server\\share\\a.png', '\\\\.\\pipe\\x', '\\\\.\\C:\\a.png', '\\\\?\\Volume{0}\\a.png', 'file://server/share/a.png', 'file:////server/share/a.png', '  \\\\server\\share']) {
    assert.equal(isRemotePath(remote), true, remote);
  }
  for (const local of ['C:\\Users\\me\\a.png', 'c:/a.png', '\\\\?\\C:\\a.png', '//?/D:/a.png', 'a.png', '..\\a.png', '\\a.png', '/home/me/a.png', '%P/optimised/%f', '~/Pictures', 'file:///C:/a.png', 'file://localhost/C:/a.png', 'sameFolder']) {
    assert.equal(isRemotePath(local), false, local);
  }
});

test('an agent path is refused as written or as resolved against a network working folder', () => {
  assert.match(agentPathRefusal(['a.png', '\\\\server\\share\\b.png'])!, /^\\\\server\\share\\b\.png is on a network share or a device/);
  assert.equal(agentPathRefusal(['a.png', 'https://example.com/b.png', undefined], process.cwd()), undefined);
  assert.match(agentPathRefusal(['a.png'], '\\\\server\\share')!, /^\\\\server\\share is on a network share/);
});

test('a template or step path is judged as written and with every token and capture empty', () => {
  for (const remote of ['%e//host/share/', '%e\\\\host\\share\\%f', '$1//host/share/', '$1$2\\\\host\\share', '%e\\\\?\\UNC\\host\\share', '//host/share']) assert.equal(isRemoteTemplate(remote), true, remote);
  for (const local of ['%P/optimised/%f', '%F', '%f-optimised', 'C:\\%e\\x', '$1/x', '%y/%m/%f', '%r%e//host', '~/%e/x', '%USERPROFILE%\\x']) assert.equal(isRemoteTemplate(local), false, local);
  assert.match(agentPathRefusal(['ok.png', '%e//host/share/%f'])!, /^%e\/\/host\/share\/%f is on a network share/);
});

test('an agent\'s expanded path must be a local drive-letter path; a person\'s is never judged', () => {
  for (const file of ['//host/share/x', '\\\\host\\share\\x', '\\\\?\\UNC\\host\\share\\x', '\\\\.\\C:\\x']) {
    assert.throws(() => requireNotRemote(true, file), /is on a network share or a device/, file);
    assert.throws(() => requireLocalDrive(true, file, 'win32'), /is on a network share or a device/, file);
    requireLocalDrive(false, file, 'win32');
  }
  assert.throws(() => requireLocalDrive(true, '\\Users\\me\\x', 'win32'), /own drives/, 'on Windows a rooted path with no drive is not a drive-letter path');
  for (const file of ['C:\\Users\\me\\x.png', 'c:/x', '\\\\?\\D:\\x']) requireLocalDrive(true, file, 'win32');
  requireLocalDrive(true, '/home/me/x.png', 'linux');
});
