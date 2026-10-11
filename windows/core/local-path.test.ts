import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPathRefusal, isRemotePath } from './local-path';

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
