import path from 'node:path';
import { stat } from 'node:fs/promises';
import { isAumid, resolveApp } from './pipeline/app-resolve';
import { run } from './run';
import type { PipelineEffects } from './pipeline/run-state';

// The clipboard, "open with" and the Recycle Bin without Electron, through Windows PowerShell, for the CLI and for the
// app's pipe requests. Values reach the script through the environment, so no quoting can change what it runs.

/** Windows PowerShell 5.1, by its full path so a `powershell.exe` earlier on PATH is never run instead. */
export const powershell = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const encoded = (code: string) => Buffer.from(code, 'utf16le').toString('base64');

async function script(code: string, env: Record<string, string>, what: string) {
  if (process.platform !== 'win32') throw new Error(`${what} needs Windows.`);
  return (await run(powershell(), ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', encoded(`$ErrorActionPreference = 'Stop'\n${code}`)], { env: { ...process.env, ...env }, timeoutMs: 60_000 })).stdout.toString('utf8');
}
const isFile = (file: string) => stat(file).then(info => info.isFile(), () => false);
/** The program an App Paths entry names (`HKCU` first, then `HKLM`), with variables in the value expanded. A name with folders has no entry. */
async function registeredApp(exe: string) {
  if (process.platform !== 'win32' || /[\\/]/.test(exe)) return undefined;
  const found = (await script(
    "foreach ($hive in 'HKEY_CURRENT_USER', 'HKEY_LOCAL_MACHINE') { $value = (Get-ItemProperty -LiteralPath \"Registry::$hive\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$($env:CLOP_EXE)\" -ErrorAction SilentlyContinue).'(default)'; if ($value) { [Console]::Out.Write([Environment]::ExpandEnvironmentVariables($value).Trim('\"')); break } }",
    { CLOP_EXE: exe }, 'Looking up an app')).trim();
  return path.win32.isAbsolute(found) ? found : undefined;
}

export interface ShellEffects extends PipelineEffects {
  /** Puts files on the clipboard as a file list, the way Explorer's Copy does. */
  copyFiles(files: string[]): Promise<void>;
}

export interface ShellEffectsOptions {
  /** The user's own pipelines may open a program by its path; an agent's (when it may not run scripts) may only open apps Windows knows. */
  allowExe?: boolean;
  /** Watched folders, where a program is never run from. */
  watched?: string[];
}

/**
 * `openWith` follows the app's rule (`resolveApp`): an app by name that Windows has an App Paths entry for, or a program by
 * path only when `allowExe`. Packaged apps need the running Clop app, which asks Windows for them.
 */
export const shellEffects = ({ allowExe = false, watched = [] }: ShellEffectsOptions = {}): ShellEffects => ({
  async copyToClipboard(item) {
    if ('text' in item) { await script('Set-Clipboard -Value $env:CLOP_TEXT', { CLOP_TEXT: item.text }, 'Copying to the clipboard'); return; }
    await script('Add-Type -AssemblyName System.Windows.Forms, System.Drawing\n$image = [System.Drawing.Image]::FromFile($env:CLOP_FILE)\ntry { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }', { CLOP_FILE: item.image }, 'Copying to the clipboard');
  },
  async copyFiles(files) {
    if (files.length) await script('Set-Clipboard -LiteralPath ($env:CLOP_FILES -split "`n")', { CLOP_FILES: files.join('\n') }, 'Copying to the clipboard');
  },
  async openWith(file, app) {
    const target = await resolveApp(app, { apps: async () => [], appPath: registeredApp, isFile, watched, allowExe });
    if (isAumid(target)) throw new Error(`${target} is a packaged app, which only the running Clop app can open files with.`);
    await script('Start-Process -FilePath $env:CLOP_APP -ArgumentList (\'"\' + $env:CLOP_FILE + \'"\')', { CLOP_APP: target, CLOP_FILE: file }, 'Opening files with an app')
      .catch(error => { throw new Error(`Could not open ${path.basename(file)} with ${app}: ${error instanceof Error ? error.message.split('\n')[0] : error}`); });
  },
  async trash(target, kind) {
    const method = kind === 'folder' ? 'DeleteDirectory' : 'DeleteFile';
    await script(`Add-Type -AssemblyName Microsoft.VisualBasic\n[Microsoft.VisualBasic.FileIO.FileSystem]::${method}($env:CLOP_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')`, { CLOP_TARGET: target }, 'Moving files to the Recycle Bin');
    return true;
  },
});
