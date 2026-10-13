import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appsReply, ignoredApp } from './apps';

test('an ignored app is matched by exe path or AUMID whatever the case and slashes, or by exe name alone', () => {
  const owner = 'C:\\Program Files\\Bitwarden\\Bitwarden.exe';
  assert.equal(ignoredApp({ owner }, ['c:/program files/bitwarden/bitwarden.exe']), true);
  assert.equal(ignoredApp({ owner }, ['bitwarden.EXE']), true);
  assert.equal(ignoredApp({ owner }, ['C:\\Program Files\\Other\\Bitwarden.exe', 'Bitwarden']), false);
  assert.equal(ignoredApp({ owner, aumid: 'Contoso.Notes_abc!App' }, ['contoso.notes_abc!app']), true);
  assert.equal(ignoredApp({}, ['bitwarden.exe']), false);
  assert.equal(ignoredApp({ owner }, []), false);
  assert.equal(ignoredApp({ owner }, ['  ']), false);
});
test('the Windows helper\'s app list is checked entry by entry and sorted with running apps first', () => {
  assert.deepEqual(appsReply({ apps: [
    { name: 'Zed', path: 'C:\\Zed\\zed.exe', running: false }, { name: ' Notepad ', path: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', running: true },
    { name: 'Alpha', path: 'C:\\Alpha\\alpha.exe' }, { name: '', path: 'C:\\x.exe' }, { name: 'No path' }, null, 'text', { name: 3, path: 'C:\\y.exe' },
  ] }), [
    { name: 'Notepad', path: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', running: true },
    { name: 'Alpha', path: 'C:\\Alpha\\alpha.exe', running: false }, { name: 'Zed', path: 'C:\\Zed\\zed.exe', running: false },
  ]);
  for (const bad of [null, {}, { apps: 'x' }]) assert.throws(() => appsReply(bad), /unreadable/);
});
