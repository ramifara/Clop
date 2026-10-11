import assert from 'node:assert/strict';
import test from 'node:test';
import { shellEffects } from './shell-effects';

// `openWith` obeys the app's rule before it starts anything (electron/pipelines.test.ts covers the rule itself): the
// refusals below happen on every platform; opening needs Windows.

test('openWith without permission refuses a program by path and any app Windows does not know', async () => {
  const effects = shellEffects({ allowExe: false });
  for (const app of ['C:\\evil.exe', '"C:\\evil.exe"', 'C:/evil.exe', '\\\\server\\share\\evil.exe']) {
    await assert.rejects(effects.openWith('C:\\a.png', app), /cannot open programs by path/, app);
  }
  for (const app of ['cmd', 'powershell', 'evil', '..\\evil', 'C:evil.exe']) await assert.rejects(effects.openWith('C:\\a.png', app), /not found/, app);
  await assert.rejects(effects.openWith('C:\\a.png', ' '), /needs the name of an app/);
});

test('openWith with permission looks the program up, and never runs one from a watched folder', async () => {
  await assert.rejects(shellEffects({ allowExe: true }).openWith('C:\\a.png', 'C:\\Tools\\missing.exe'), /not found/);
  // On Windows the file is not a file here either; the folder rule applies first.
  await assert.rejects(shellEffects({ allowExe: true, watched: ['C:\\Users\\me\\Desktop'] }).openWith('C:\\a.png', 'C:\\Users\\me\\Desktop\\tool.exe'), /not found|inside the watched folder/);
});
