import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasLongPathAware, inspectManifest, isLongPathAware, setLongPathAware, withLongPathAware } from './after-pack.mjs';

const WS2 = 'xmlns:ws2="http://schemas.microsoft.com/SMI/2016/WindowsSettings"';
const SETTING = `<ws2:longPathAware ${WS2}>true</ws2:longPathAware>`;
const ASM3 = 'urn:schemas-microsoft-com:asm.v3';
/** The manifest of Electron 44.7.0's electron.exe, verbatim (it binds asm.v3 to a prefix and has an `application` of another namespace inside `compatibility`). */
const ELECTRON_44 = `<?xml version="1.0" encoding="UTF-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
<asmv3:application xmlns:asmv3="${ASM3}"><asmv3:windowsSettings xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings"><disableWindowFiltering xmlns="http://schemas.microsoft.com/SMI/2011/WindowsSettings">true</disableWindowFiltering></asmv3:windowsSettings><asmv3:windowsSettings xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings"><dpiAware>true/pm</dpiAware></asmv3:windowsSettings></asmv3:application><trustInfo xmlns="${ASM3}"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo><dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency><compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{e2011457-1546-43c5-a5fe-008deee3d3f0}"/><supportedOS Id="{35138b9a-5d96-4fbd-8e2d-a2440225f93a}"/><supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}"/><supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/><maxversiontested Id="10.0.18362.0"/></application></compatibility></assembly>`;
const head = `<?xml version='1.0' encoding='UTF-8' standalone='yes'?><assembly xmlns='urn:schemas-microsoft-com:asm.v1' manifestVersion='1.0'><trustInfo xmlns="${ASM3}"><security><requestedPrivileges><requestedExecutionLevel level='asInvoker' uiAccess='false'/></requestedPrivileges></security></trustInfo>`;
const dpi = '<dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>';

test('Electron\'s own manifest gets longPathAware inside its one asm.v3 application, in the first windowsSettings, and nothing else changes', () => {
  assert.deepEqual(inspectManifest(ELECTRON_44), { applications: 1, longPathAware: [] });
  const updated = withLongPathAware(ELECTRON_44);
  const marker = '</disableWindowFiltering>';
  assert.equal(updated, ELECTRON_44.replace(marker, marker).replace('</asmv3:windowsSettings><asmv3:windowsSettings', `${SETTING}</asmv3:windowsSettings><asmv3:windowsSettings`));
  assert.deepEqual(inspectManifest(updated), { applications: 1, longPathAware: ['true'] });
  assert.ok(isLongPathAware(updated) && !isLongPathAware(ELECTRON_44));
  assert.equal(withLongPathAware(updated), updated, 'setting it twice changes nothing');
  assert.ok(updated.includes('<compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS'), 'the compatibility section is as it was');
});
test('the element is found by namespace, however asm.v3 is spelled, and a missing windowsSettings is made with the application\'s prefix', () => {
  const plain = `${head}<application xmlns="${ASM3}"><windowsSettings>${dpi}</windowsSettings></application></assembly>`;
  assert.equal(withLongPathAware(plain), `${head}<application xmlns="${ASM3}"><windowsSettings>${dpi}${SETTING}</windowsSettings></application></assembly>`);
  const other = `${head}<v3:application xmlns:v3="${ASM3}"></v3:application></assembly>`;
  assert.equal(withLongPathAware(other), `${head}<v3:application xmlns:v3="${ASM3}"><v3:windowsSettings>${SETTING}</v3:windowsSettings></v3:application></assembly>`);
  // An application of another namespace, even one with attributes, is not where the setting goes.
  const compat = `${head}<compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application id="x"><supportedOS Id="{1}"/></application></compatibility></assembly>`;
  const added = withLongPathAware(compat);
  assert.deepEqual(inspectManifest(added), { applications: 1, longPathAware: ['true'] });
  assert.ok(added.includes('<application id="x"><supportedOS Id="{1}"/></application>'));
});
test('a manifest with no application, or empty application and windowsSettings elements, gets them filled', () => {
  const settings = `<windowsSettings>${SETTING}</windowsSettings>`;
  assert.equal(withLongPathAware(`${head}</assembly>`), `${head}<application xmlns="${ASM3}">${settings}</application></assembly>`);
  assert.equal(withLongPathAware(`${head}<application xmlns="${ASM3}"/></assembly>`), `${head}<application xmlns="${ASM3}">${settings}</application></assembly>`);
  assert.equal(withLongPathAware(`${head}<application xmlns="${ASM3}"><windowsSettings/></application></assembly>`), `${head}<application xmlns="${ASM3}"><windowsSettings>${SETTING}</windowsSettings></application></assembly>`);
  assert.equal(withLongPathAware(`${head}<application xmlns="${ASM3}"></application></assembly>`), `${head}<application xmlns="${ASM3}">${settings}</application></assembly>`);
});
test('an existing longPathAware that is false becomes true, whatever its prefix', () => {
  const off = `${head}<application xmlns="${ASM3}"><windowsSettings><ws:longPathAware xmlns:ws="http://schemas.microsoft.com/SMI/2016/WindowsSettings">false</ws:longPathAware></windowsSettings></application></assembly>`;
  const on = withLongPathAware(off);
  assert.ok(isLongPathAware(on) && !isLongPathAware(off));
  assert.equal(on, off.replace('>false<', '>true<'));
  assert.throws(() => withLongPathAware(`${head}<application xmlns="${ASM3}"><windowsSettings><ws:longPathAware xmlns:ws="http://schemas.microsoft.com/SMI/2016/WindowsSettings"/></windowsSettings></application></assembly>`), /empty longPathAware/);
  assert.throws(() => withLongPathAware('<nothing/>'), /no assembly element/);
  assert.throws(() => withLongPathAware(`${head}<application xmlns="${ASM3}"></assembly>`), /not well formed/);
});
test('a second application element or a second longPathAware is not "set once"', () => {
  const twice = withLongPathAware(ELECTRON_44).replace('</asmv3:application>', `</asmv3:application><application xmlns="${ASM3}"><windowsSettings>${SETTING}</windowsSettings></application>`);
  assert.deepEqual(inspectManifest(twice), { applications: 2, longPathAware: ['true', 'true'] });
  assert.equal(isLongPathAware(twice), false);
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
