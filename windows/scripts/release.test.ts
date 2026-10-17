import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeUpdateInfo, readUpdateInfo, releaseNotes, versionOfTag } from './release.mjs';

/** A `latest.yml` as electron-builder writes it for one architecture's NSIS build. */
const latest = (version: string, arch: string, date = '2026-10-17T12:00:00.000Z') => `version: ${version}
files:
  - url: Clop-Windows-${version}-${arch}-Setup.exe
    sha512: ${arch}hash==
    size: ${arch === 'x64' ? 118743974 : 112000000}
path: Clop-Windows-${version}-${arch}-Setup.exe
sha512: ${arch}hash==
releaseDate: '${date}'
`;

test('the update info of each architecture becomes one file, x64 first, that electron-updater can pick its own installer from', () => {
  const merged = readUpdateInfo(mergeUpdateInfo([latest('1.0.0-beta.2', 'arm64', '2026-10-17T12:05:00.000Z'), latest('1.0.0-beta.2', 'x64')], '1.0.0-beta.2'));
  assert.equal(merged.version, '1.0.0-beta.2');
  assert.deepEqual(merged.files.map(file => file.url), ['Clop-Windows-1.0.0-beta.2-x64-Setup.exe', 'Clop-Windows-1.0.0-beta.2-arm64-Setup.exe']);
  assert.deepEqual(merged.files[1], { url: 'Clop-Windows-1.0.0-beta.2-arm64-Setup.exe', sha512: 'arm64hash==', size: 112000000 });
  assert.equal(merged.path, 'Clop-Windows-1.0.0-beta.2-x64-Setup.exe');
  assert.equal(merged.sha512, 'x64hash==');
  assert.equal(merged.releaseDate, '2026-10-17T12:05:00.000Z');
  // electron-updater takes the first file whose name includes process.arch: each architecture must find its own, and only its own.
  for (const arch of ['x64', 'arm64']) assert.deepEqual(merged.files.filter(file => file.url.includes(arch)).map(file => file.url), [`Clop-Windows-1.0.0-beta.2-${arch}-Setup.exe`]);
});

test('update info that is for another version, lists an architecture twice or names none is refused', () => {
  assert.throws(() => mergeUpdateInfo([latest('1.0.0-beta.1', 'x64')], '1.0.0-beta.2'), /for 1\.0\.0-beta\.1, not 1\.0\.0-beta\.2/);
  assert.throws(() => mergeUpdateInfo([latest('1.0.0', 'x64'), latest('1.0.0', 'x64')], '1.0.0'), /Two builds list a x64 installer/);
  assert.throws(() => mergeUpdateInfo([latest('1.0.0', 'ia32')], '1.0.0'), /does not name its architecture/);
  assert.throws(() => mergeUpdateInfo(['version: 1.0.0\nfiles: []\n'], '1.0.0'), /No installer/);
});

test('release notes are the version\'s CHANGELOG entry, which must exist and be released', () => {
  const changelog = '# Changelog\n\nIntro.\n\n## 1.0.0-beta.2 (2026-10-17)\n\nFaster.\n- One.\n\n## 1.0.0-beta.1 (not yet released)\n\nFirst.\n';
  assert.equal(releaseNotes(changelog, '1.0.0-beta.2'), 'Faster.\n- One.\n');
  assert.throws(() => releaseNotes(changelog, '1.0.0-beta.1'), /not yet released/);
  assert.throws(() => releaseNotes(changelog, '1.0.0'), /no entry for 1\.0\.0/);
  // 1.0.0 must not match the 1.0.0-beta.2 heading.
  assert.throws(() => releaseNotes('## 1.0.0-beta.2 (2026-10-17)\n\nFaster.\n', '1.0.0'), /no entry/);
  assert.equal(releaseNotes('## 1.0.0 (2026-11-01)\r\n\r\nStable.\r\n', '1.0.0'), 'Stable.\n');
});

test('a release tag is v and the package version', () => {
  assert.equal(versionOfTag('v1.0.0-beta.2', '1.0.0-beta.2'), '1.0.0-beta.2');
  assert.throws(() => versionOfTag('v1.0.0-beta.3', '1.0.0-beta.2'), /does not match/);
  assert.throws(() => versionOfTag('windows-v1.0.0-beta.2', '1.0.0-beta.2'), /does not match/);
});
