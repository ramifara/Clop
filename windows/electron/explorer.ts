import { rm } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../core/run';
import { powershell } from '../core/shell-effects';
import { regAdd, regDelete, regExe, regQuery, verbPlan, type SendToShortcut, type VerbPaths } from '../core/shell-verbs';
import { installPortableCLI, portableCLIDir } from './cli-install';

// Explorer's right-click verbs and the Send To shortcut for the portable app (spec step 39): the installer writes them itself, with the
// same plan (`core/shell-verbs.ts`). Windows only: everywhere else the calls refuse, so nothing reaches the registry from a test run.

/** What the integration needs from the system; the default runs `reg.exe` and PowerShell, tests give their own. */
export interface ExplorerHost {
  platform: NodeJS.Platform;
  /** Runs reg.exe with these arguments and gives its exit code. */
  reg(args: string[]): Promise<number>;
  /** Makes (or replaces) the shortcut at `file`. */
  shortcut(file: string, link: SendToShortcut): Promise<void>;
  remove(file: string): Promise<void>;
  sendToDir(): string;
}

const sendToDir = () => path.join(process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'SendTo');
const SHORTCUT = "$link = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CLOP_LINK); $link.TargetPath = $env:CLOP_TARGET; $link.Arguments = $env:CLOP_ARGS; $link.IconLocation = $env:CLOP_ICON + ',0'; $link.Save()";

export const systemHost: ExplorerHost = {
  platform: process.platform,
  // The absolute System32 path and an argument array: no shell, and a `reg.exe` earlier on PATH is never run.
  reg: args => run(regExe(), args, { timeoutMs: 30_000 }).then(result => result.code, error => (typeof error?.exitCode === 'number' ? error.exitCode : Promise.reject(error))),
  shortcut: async (file, { target, args, icon }) => {
    // Values travel in the environment, so no quoting can change what the script runs.
    await run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n${SHORTCUT}`, 'utf16le').toString('base64')],
      { env: { ...process.env, CLOP_LINK: file, CLOP_TARGET: target, CLOP_ARGS: args, CLOP_ICON: icon }, timeoutMs: 30_000 });
  },
  remove: file => rm(file, { force: true }),
  sendToDir,
};

const needWindows = (host: ExplorerHost) => { if (host.platform !== 'win32') throw new Error('The Explorer menu entries need Windows.'); };

/** Whether the first verb is registered, which is how the tray knows to offer "Remove". */
export async function verbsInstalled(paths: VerbPaths, host: ExplorerHost = systemHost) {
  if (host.platform !== 'win32') return false;
  return await host.reg(regQuery(verbPlan(paths).roots[0])).catch(() => 1) === 0;
}

/** Writes every verb and the Send To shortcut, after clearing any earlier ones. A failure part-way removes what was written. */
export async function installVerbs(paths: VerbPaths, host: ExplorerHost = systemHost) {
  needWindows(host);
  const plan = verbPlan(paths);
  await removeVerbs(paths, host);
  try {
    for (const value of plan.values) {
      const code = await host.reg(regAdd(value));
      if (code !== 0) throw new Error(`reg.exe could not write ${value.key} (exit ${code}).`);
    }
    await host.shortcut(path.join(host.sendToDir(), plan.sendTo.file), plan.sendTo);
  } catch (error) {
    await removeVerbs(paths, host).catch(() => {});
    throw error;
  }
}

/** Deletes exactly the plan's verb keys and shortcut. A key that is not there is not an error. */
export async function removeVerbs(paths: VerbPaths, host: ExplorerHost = systemHost) {
  needWindows(host);
  const plan = verbPlan(paths);
  for (const key of plan.roots) await host.reg(regDelete(key));
  await host.remove(path.join(host.sendToDir(), plan.sendTo.file));
}

/** The portable app's paths: its own copy of clop.exe (see `installPortableCLI`) and the exe the user started, which is what a later launch must reach. */
export const portablePaths = (): VerbPaths => ({ clop: path.join(portableCLIDir(), 'clop.exe'), app: process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath });

/** Adds the entries for the portable app, which first puts its copy of clop.exe in place (and records where the app is). */
export async function installPortableVerbs(resources: string, appDir: string, host: ExplorerHost = systemHost) {
  needWindows(host);
  await installPortableCLI(resources, appDir);
  await installVerbs(portablePaths(), host);
}
