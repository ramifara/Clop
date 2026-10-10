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

/**
 * A script file gets the input file as its first argument. A .ps1 runs through PowerShell, which takes both from the
 * environment; an .exe runs directly; anything else through cmd, which reads the input from `%CLOP_INPUT_FILE%` inside
 * quotes, so the file's name is never parsed as part of the command line (cmd does not expand a variable's value again).
 */
async function scriptCommand(script: string, input: string): Promise<Command> {
  const ext = path.extname(script).toLowerCase();
  if (process.platform === 'win32') {
    // The script is local and not marked as downloaded (checked before), so the execution policy is not what protects here.
    if (ext === '.ps1') return { command: powershell(), args: [...POWERSHELL_ARGS, '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded('& $env:CLOP_SCRIPT $env:CLOP_INPUT_FILE; exit $LASTEXITCODE')] };
    if (ext === '.exe' || ext === '.com') return { command: script, args: [input] };
    // /s strips the outer quotes and keeps the inner ones; code page 65001 makes the script's output UTF-8.
    return { command: system32('cmd.exe'), args: ['/d', '/s', '/c', `"chcp 65001 >nul & "${script}" "%CLOP_INPUT_FILE%""`], verbatim: true };
  }
  const executable = await access(script, constants.X_OK).then(() => true, () => false);
  return executable ? { command: script, args: [input] } : { command: 'sh', args: [script, input] };
}

/** Windows PowerShell writes errors to a redirected stderr as CLIXML; this turns them back into the text a console shows. */
export function readableStderr(stderr: string): string {
  if (!stderr.includes('#< CLIXML')) return stderr;
  const decode = (text: string) => text.replace(/_x([0-9A-F]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const errors = [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(([, text]) => decode(text));
  return errors.join('').split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n');
}

/** Whether Windows marked the file as downloaded from the internet. */
async function markedAsDownloaded(file: string) {
  if (process.platform !== 'win32') return false;
  return readFile(`${file}:Zone.Identifier`, 'utf8').then(text => /ZoneId=[3-4]/.test(text), () => false);
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
  const env = { ...process.env, CLOP_INPUT_FILE: input, ...(script ? { CLOP_SCRIPT: script } : {}), ...(bin ? { CLOP_BIN: bin } : {}) };
  const cwd = script ? path.dirname(script) : await run.scratch();
  let printed: string;
  try {
    printed = (await runTool(command, args, { env, cwd, signal: run.signal, windowsVerbatimArguments: verbatim })).stdout.toString('utf8').trim();
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
  const extensions = process.platform === 'win32' ? ['', '.ps1', '.bat', '.cmd', '.exe'] : ['', '.sh'];
  const usable = name.trim() && !/[\\/:]/.test(name) && name !== '.' && name !== '..';
  for (const ext of usable ? extensions : []) {
    const script = path.join(dir, name + ext);
    if (await isFile(script)) return runFile(run, script, undefined, 'runShortcut');
  }
  throw new Error(`"${name}" is a macOS Shortcut, and Windows has no Shortcuts app. Put a script named ${name}.ps1, .bat, .cmd or .exe in ${dir}, or use runScript.`);
}
