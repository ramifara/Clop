import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// What the packaged app is built with: checked here, since only the Windows CI builds and runs it.
const build = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).build;

test('the Electron fuses keep Node switches out of the packaged app, check its asar and keep RunAsNode for clop.exe', () => {
  // clop.exe runs the command line inside the app's Electron as Node, so RunAsNode stays on; it passes no Node options or inspector switches.
  assert.deepEqual(build.electronFuses, { runAsNode: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true });
});
