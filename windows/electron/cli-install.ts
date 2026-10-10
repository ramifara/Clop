import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../core/run';

// "Install command-line tool" for the portable build (spec step 26). The installer puts its own `cli` folder on PATH; a
// portable app unpacks to a new temporary folder on each start, so it copies clop.exe to a fixed folder, puts that on
// PATH, and records where the app is now, which clop.exe falls back to when the app is not beside it.

const powershell = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** `%LOCALAPPDATA%\Clop for Windows\cli`, where the portable app keeps its copy of clop.exe. */
export const portableCLIDir = () => path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'Clop for Windows', 'cli');
export const isPortable = () => process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;
export const portableCLIInstalled = () => stat(path.join(portableCLIDir(), 'clop.exe')).then(() => true, () => false);

async function pathScript(resources: string, action: 'add' | 'remove', dir: string, installDir: string) {
  await run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(resources, 'native', 'path.ps1'), '-Action', action, '-Dir', dir, '-InstallDir', installDir], { timeoutMs: 60_000 });
}

/** Copies clop.exe out of the unpacked app and puts it on PATH, recording the app's current folder. */
export async function installPortableCLI(resources: string, appDir: string) {
  await mkdir(portableCLIDir(), { recursive: true });
  await copyFile(path.join(appDir, 'cli', 'clop.exe'), path.join(portableCLIDir(), 'clop.exe'));
  await pathScript(resources, 'add', portableCLIDir(), appDir);
}

export async function removePortableCLI(resources: string, appDir: string) {
  await pathScript(resources, 'remove', portableCLIDir(), appDir);
  await rm(portableCLIDir(), { recursive: true, force: true });
}

/** On each start of an installed portable CLI: the app unpacked somewhere new, so clop.exe must look there. */
export async function refreshPortableCLI(resources: string, appDir: string) {
  if (await portableCLIInstalled()) await installPortableCLI(resources, appDir);
}
