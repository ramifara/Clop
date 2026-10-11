import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// What the packaged app is built with: checked here, since only the Windows CI builds and runs it.
const build = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).build;

test('the Electron fuses keep Node switches out of the packaged app, check its asar and keep RunAsNode for clop.exe', () => {
  // clop.exe runs the command line inside the app's Electron as Node, so RunAsNode stays on; it passes no Node options or inspector switches.
  assert.deepEqual(build.electronFuses, { runAsNode: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true });
});

test('uninstalling removes the clop:// handler and the login entry the app added, when they start the uninstalled exe', () => {
  const script = readFileSync(new URL('../native/installer.nsh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const macro = script.split('!macro clopRuntimeEntriesRemove\n')[1]?.split('!macroend')[0] ?? '';
  assert.match(macro, /StrCpy \$R1 '"\$INSTDIR\\Clop for Windows\.exe"'/);
  assert.match(macro, /ReadRegStr \$R0 HKCU "Software\\Classes\\clop\\shell\\open\\command" ""[^]*DeleteRegKey HKCU "Software\\Classes\\clop"/);
  assert.match(macro, /EnumRegValue \$R0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" \$R4[^]*DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" \$R0/);
  // Only on a real uninstall: an update runs the old uninstaller first and the app adds both again.
  assert.match(script, /\$\{ifNot\} \$\{isUpdated\}[^]*!insertmacro clopRuntimeEntriesRemove\n {2}\$\{endif\}/);
});
