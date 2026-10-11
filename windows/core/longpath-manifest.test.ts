import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasLongPathAware, isLongPathAware, setLongPathAware, withLongPathAware } from '../scripts/after-pack.mjs';

const head = `<?xml version='1.0' encoding='UTF-8' standalone='yes'?><assembly xmlns='urn:schemas-microsoft-com:asm.v1' manifestVersion='1.0'><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level='asInvoker' uiAccess='false'/></requestedPrivileges></security></trustInfo>`;
const SETTING = '<ws2:longPathAware xmlns:ws2="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</ws2:longPathAware>';
const dpi = '<dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>';

test('longPathAware joins the windowsSettings an Electron-style manifest already has', () => {
  const xml = `${head}<application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>${dpi}</windowsSettings></application></assembly>`;
  const updated = withLongPathAware(xml);
  assert.equal(updated, `${head}<application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>${dpi}${SETTING}</windowsSettings></application></assembly>`);
  assert.ok(isLongPathAware(updated) && !isLongPathAware(xml));
  assert.equal(withLongPathAware(updated), updated, 'setting it twice changes nothing');
});
test('a manifest with an application but no windowsSettings, none of either, or empty ones gets them made', () => {
  const settings = `<windowsSettings>${SETTING}</windowsSettings>`;
  assert.equal(withLongPathAware(`${head}<application xmlns="urn:schemas-microsoft-com:asm.v3"></application></assembly>`), `${head}<application xmlns="urn:schemas-microsoft-com:asm.v3">${settings}</application></assembly>`);
  assert.equal(withLongPathAware(`${head}</assembly>`), `${head}<application xmlns="urn:schemas-microsoft-com:asm.v3">${settings}</application></assembly>`);
  assert.equal(withLongPathAware(`${head}<application xmlns="urn:schemas-microsoft-com:asm.v3"/></assembly>`), `${head}<application xmlns="urn:schemas-microsoft-com:asm.v3">${settings}</application></assembly>`);
  assert.equal(withLongPathAware(`${head}<application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings/></application></assembly>`), `${head}<application xmlns="urn:schemas-microsoft-com:asm.v3">${settings}</application></assembly>`);
});
test('an existing longPathAware that is false becomes true, whatever its prefix', () => {
  const off = `${head}<application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><ws:longPathAware xmlns:ws="http://schemas.microsoft.com/SMI/2016/WindowsSettings">false</ws:longPathAware></windowsSettings></application></assembly>`;
  const on = withLongPathAware(off);
  assert.ok(isLongPathAware(on) && !isLongPathAware(off));
  assert.equal(on, off.replace('>false<', '>true<'));
  assert.throws(() => withLongPathAware('<assembly><longPathAware/></assembly>'), /empty longPathAware/);
  assert.throws(() => withLongPathAware('<nothing/>'), /no assembly element/);
});

// A real executable with a manifest, from electron-builder's own dependencies; the rest of the test needs no executable.
const sample = path.join(import.meta.dirname, '../node_modules/electron-winstaller/vendor/rcedit.exe');
test('the manifest of a Windows executable is rewritten and read back', { skip: !existsSync(sample) && 'no sample executable installed' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-manifest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'app.exe');
  await copyFile(sample, exe);
  assert.equal(await hasLongPathAware(exe), false);
  assert.equal(await setLongPathAware(exe), true);
  assert.equal(await hasLongPathAware(exe), true);
  assert.equal(await setLongPathAware(exe), false);
});
