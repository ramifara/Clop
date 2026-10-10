import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { samePath } from '../fileops';
import { detectKind } from '../media/detect';
import { run as runTool, ToolError } from '../run';
import { defaultPaths } from '../settings/paths';
import { toolsDir } from '../tools';
import type { RunState } from './run-state';

// `runScript` and `runShortcut` (PipelineExecution.swift). A pipeline can run on files that just arrived in a watched folder,
// so nothing those files bring decides what runs: script paths must be absolute, Shortcut names only find scripts in Clop's
// own scripts folder, scripts run from their own folder (inline code from an empty one), and a script downloaded from the
// internet (a Zone.Identifier stream, Windows' mark of the web) is refused until the user unblocks it.

const isFile = (file: string) => stat(file).then(info => info.isFile(), () => false);
const onPath = async (name: string) => {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir && await isFile(path.join(dir, name))) return true;
  return false;
};
const system32 = (...parts: string[]) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts);
const powershell = () => system32('WindowsPowerShell', 'v1.0', 'powershell.exe');
/** Output is written as UTF-8, so a printed path with any characters comes back intact. */
const UTF8_OUTPUT = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n';
const encoded = (code: string) => Buffer.from(UTF8_OUTPUT + code, 'utf16le').toString('base64');
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive'];

/** Where `runShortcut(name: "Resize")` looks for `Resize.ps1`, `Resize.bat`, `Resize.cmd` or `Resize.exe`. */
export const defaultScriptsDir = () => path.join(defaultPaths().userData, 'scripts');

interface Command { command: string; args: string[]; verbatim?: boolean }

/**
 * Inline code runs in Windows PowerShell, passed encoded so no quoting can change it. Off Windows (development and tests)
 * it runs in `pwsh` when installed, otherwise `sh -c` with the input file as `$1`.
 */
async function inlineCommand(code: string, input: string): Promise<Command> {
  const args = [...POWERSHELL_ARGS, '-EncodedCommand', encoded(code)];
  if (process.platform === 'win32') return { command: powershell(), args };
  if (await onPath('pwsh')) return { command: 'pwsh', args };
  return { command: 'sh', args: ['-c', code, 'clop', input] };
}

/** The script files Windows runs: anything else (`.js`, `.vbs`, `.lnk`, a file without an extension) would run through a file association. */
export const WINDOWS_SCRIPT_EXTENSIONS = ['.ps1', '.bat', '.cmd', '.exe', '.com'];
export function checkWindowsScript(script: string) {
  const ext = path.extname(script).toLowerCase();
  if (!WINDOWS_SCRIPT_EXTENSIONS.includes(ext)) throw new Error(`Clop runs .ps1, .bat, .cmd, .exe and .com scripts, not ${ext ? `${ext} files` : 'files without an extension'}: ${script}`);
}

/**
 * A script file gets the input file as its first argument. A .ps1 runs through PowerShell `-File`; an .exe or .com runs
 * directly; a .bat or .cmd runs through cmd, which reads both paths from the environment inside quotes, so neither is parsed
 * as part of the command line (cmd does not expand a variable's value again). `chcp` is called by its full path, so a
 * `chcp.bat` beside the script cannot stand in for it.
 */
async function scriptCommand(script: string, input: string): Promise<Command> {
  const ext = path.extname(script).toLowerCase();
  if (process.platform === 'win32') {
    checkWindowsScript(script);
    // The script is local and not marked as downloaded (checked before), so the execution policy is not what protects here.
    if (ext === '.ps1') return { command: powershell(), args: [...POWERSHELL_ARGS, '-ExecutionPolicy', 'Bypass', '-File', script, input] };
    if (ext === '.exe' || ext === '.com') return { command: script, args: [input] };
    // /s strips the outer quotes and keeps the inner ones; code page 65001 makes the script's output UTF-8.
    return { command: system32('cmd.exe'), args: ['/d', '/s', '/c', `""${system32('chcp.com')}" 65001 >nul & "%CLOP_SCRIPT%" "%CLOP_INPUT_FILE%""`], verbatim: true };
  }
  const executable = await access(script, constants.X_OK).then(() => true, () => false);
  return executable ? { command: script, args: [input] } : { command: 'sh', args: [script, input] };
}

/**
 * Windows PowerShell writes errors to a redirected stderr as CLIXML; this turns them back into the text a console shows.
 * Plain lines a script wrote between them stay where they were.
 */
export function readableStderr(stderr: string): string {
  if (!stderr.includes('#< CLIXML') && !stderr.includes('<Objs ')) return stderr;
  const decode = (text: string) => text.replace(/_x([0-9A-F]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const lines = stderr.split(/\r?\n/).flatMap(line => {
    if (line.trim() === '#< CLIXML') return [];
    if (!line.includes('<Objs ')) return [line];
    return [...line.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(([, text]) => decode(text)).join('').split(/\r?\n/);
  });
  return lines.map(line => line.trim()).filter(Boolean).join('\n');
}

/** Whether a Zone.Identifier stream marks its file as from the internet or an untrusted site (zones 3 and 4). */
export function zoneMarksDownload(stream: Buffer): boolean {
  const text = stream[0] === 0xff && stream[1] === 0xfe ? stream.subarray(2).toString('utf16le') : stream.toString('utf8').replace(/^\uFEFF/, '');
  return /^\s*ZoneId\s*=\s*([3-4])\b/im.test(text);
}

/**
 * Whether Windows marked the file as downloaded from the internet. Fails closed: only a missing stream means unmarked,
 * and a stream that cannot be read refuses the script.
 */
export async function markedAsDownloaded(file: string, { platform = process.platform, read = (target: string) => readFile(target) }: { platform?: NodeJS.Platform; read?: (target: string) => Promise<Buffer> } = {}) {
  if (platform !== 'win32') return false;
  try { return zoneMarksDownload(await read(`${file}:Zone.Identifier`)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Clop could not check whether ${file} was downloaded from the internet (${(error as Error).message}), so it does not run it.`);
  }
}

/** Script output as UTF-8, or as Windows-1252 when it is not valid UTF-8 (an .exe writing in the ANSI code page). */
export function decodeOutput(stdout: Buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(stdout); } catch { return new TextDecoder('windows-1252').decode(stdout); }
}

async function runFile(run: RunState, script: string | undefined, code: string | undefined, label: string) {
  if (!run.opts.allowScripts) throw new Error(`This pipeline runs a script (${label}), and scripts are not allowed here.`);
  const input = run.current, name = script ? path.basename(script) : 'inline code';
  if (script) {
    if (!await isFile(script)) throw new Error(`Script not found: ${script}`);
    if (await markedAsDownloaded(script)) throw new Error(`${script} was downloaded from the internet. Check it, then unblock it in its Properties (or with Unblock-File) to run it.`);
  }
  const { command, args, verbatim } = script ? await scriptCommand(script, input) : await inlineCommand(code!, input);
  const bin = toolsDir();
  // NoDefaultCurrentDirectoryInExePath keeps cmd and PowerShell from running a program found in the working folder.
  const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1', CLOP_INPUT_FILE: input, ...(script ? { CLOP_SCRIPT: script } : {}), ...(bin ? { CLOP_BIN: bin } : {}) };
  const cwd = script ? path.dirname(script) : await run.scratch();
  let printed: string;
  try {
    printed = decodeOutput((await runTool(command, args, { env, cwd, signal: run.signal, windowsVerbatimArguments: verbatim })).stdout).trim();
  } catch (error) {
    if (run.signal?.aborted || !(error instanceof Error)) throw error;
    if (error instanceof ToolError) { const detail = readableStderr(error.stderr); throw new Error(`Script '${name}' failed (exit ${error.exitCode ?? 'killed'})${detail ? `: ${detail}` : ''}`); }
    throw new Error(`Script '${name}' failed to start: ${error.message}`);
  }
  // One absolute path to another existing file of the kind being processed (or an unknown kind) carries on.
  if (!printed || /[\r\n]/.test(printed) || !path.isAbsolute(printed) || samePath(printed, input) || !await isFile(printed)) return;
  const kind = await detectKind(printed, { signal: run.signal }).catch(() => undefined);
  if (!kind || kind === run.fileType) run.current = path.resolve(printed);
}

/**
 * `handleRunScript`: runs inline code or a script file with `CLOP_INPUT_FILE` and `CLOP_BIN` set. The path must be absolute
 * once its tokens are expanded (`%P/fix.ps1` and `~/scripts/fix.ps1` are). A non-zero exit stops the pipeline.
 */
export async function runScript(run: RunState, { path: scriptPath, code }: { path?: string; code?: string }) {
  if (code?.trim()) return runFile(run, undefined, code, 'runScript');
  const script = run.resolve(scriptPath ?? '');
  if (!path.isAbsolute(script)) throw new Error(`runScript needs the full path of a script, such as "%P/fix.ps1" or "~/scripts/fix.ps1", not "${script}".`);
  return runFile(run, path.resolve(script), undefined, 'runScript');
}

/** `runShortcut(name)`: Windows has no Shortcuts app, so it runs the script of that name in Clop's scripts folder. */
export async function runShortcut(run: RunState, name: string) {
  const dir = run.opts.scriptsDir ?? defaultScriptsDir();
  const extensions = process.platform === 'win32' ? ['.ps1', '.bat', '.cmd', '.exe', '.com'] : ['', '.sh'];
  const usable = name.trim() && !/[\\/:]/.test(name) && name !== '.' && name !== '..';
  for (const ext of usable ? extensions : []) {
    const script = path.join(dir, name + ext);
    if (await isFile(script)) return runFile(run, script, undefined, 'runShortcut');
  }
  throw new Error(`"${name}" is a macOS Shortcut, and Windows has no Shortcuts app. Put a script named ${name}.ps1, .bat, .cmd, .exe or .com in ${dir}, or use runScript.`);
}
