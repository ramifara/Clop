import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { copyTo, samePath } from '../fileops';
import { detectKind } from '../media/detect';
import { run as runTool, ToolError } from '../run';
import { toolsDir } from '../tools';
import { applyLocation } from './files';
import { stepEntry, type PipelineStep, type StepParamMap } from './model';
import { stepLocation } from './processing';
import type { RunState } from './run-state';

// The action steps (PipelineExecution.swift): scripts, the clipboard, fork, and handing the file to another app. Windows has
// no Shortcuts app, shelf apps or Dropshare: `runShortcut` runs a script of that name, `shelveWith` and `uploadWith` open the
// file with the named app, and `copyLinkForSending` fails until an upload target exists.

const isFile = (file: string) => stat(file).then(info => info.isFile(), () => false);
const onPath = async (name: string) => {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir && await isFile(path.join(dir, name))) return true;
  return false;
};
const powershell = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** Script output is read as UTF-8, so a printed path with any characters comes back intact. */
const UTF8_OUTPUT = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n';
const encoded = (code: string) => Buffer.from(UTF8_OUTPUT + code, 'utf16le').toString('base64');

interface Command { command: string; args: string[]; verbatim?: boolean }

/**
 * Inline code runs in Windows PowerShell, passed encoded so no quoting can change it. Off Windows (development and tests)
 * it runs in `pwsh` when installed, otherwise `sh -c` with the input file as `$1`.
 */
async function inlineCommand(code: string, input: string): Promise<Command> {
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(code)];
  if (process.platform === 'win32') return { command: powershell(), args };
  if (await onPath('pwsh')) return { command: 'pwsh', args };
  return { command: 'sh', args: ['-c', code, 'clop', input] };
}

/** A script file gets the input file as its first argument: .ps1 through PowerShell, .exe directly, anything else through cmd. */
async function scriptCommand(script: string, input: string): Promise<Command> {
  const ext = path.extname(script).toLowerCase();
  if (process.platform === 'win32') {
    if (ext === '.ps1') return { command: powershell(), args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, input] };
    if (ext === '.exe' || ext === '.com') return { command: script, args: [input] };
    // cmd /s strips the outer quotes and keeps the inner ones, so paths with spaces survive.
    return { command: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', `""${script}" "${input}""`], verbatim: true };
  }
  const executable = await access(script, constants.X_OK).then(() => true, () => false);
  return executable ? { command: script, args: [input] } : { command: 'sh', args: [script, input] };
}

/**
 * `handleRunScript`: runs inline code or a script file with `CLOP_INPUT_FILE` and `CLOP_BIN` set. A non-zero exit stops the
 * pipeline. When the script prints the path of another existing file of the same kind, that file carries on.
 */
export async function runScript(run: RunState, { path: scriptPath, code }: Partial<StepParamMap['runScript']>, label = 'runScript') {
  if (!run.opts.allowScripts) throw new Error(`This pipeline runs a script (${label}), and scripts are not allowed here.`);
  const input = run.current, inline = code?.trim() ? code : undefined;
  const script = inline ? '' : path.resolve(path.dirname(input), run.resolve(scriptPath ?? ''));
  const name = inline ? 'inline code' : path.basename(script);
  if (!inline && !await isFile(script)) throw new Error(`Script not found: ${script}`);
  const { command, args, verbatim } = inline ? await inlineCommand(inline, input) : await scriptCommand(script, input);
  const bin = toolsDir();
  const env = { ...process.env, CLOP_INPUT_FILE: input, ...(bin ? { CLOP_BIN: bin } : {}) };
  let printed: string;
  try {
    printed = (await runTool(command, args, { env, cwd: path.dirname(input), signal: run.signal, windowsVerbatimArguments: verbatim })).stdout.toString('utf8').trim();
  } catch (error) {
    if (run.signal?.aborted || !(error instanceof Error)) throw error;
    if (error instanceof ToolError) throw new Error(`Script '${name}' failed (exit ${error.exitCode ?? 'killed'})${error.stderr ? `: ${error.stderr}` : ''}`);
    throw new Error(`Script '${name}' failed to start: ${error.message}`);
  }
  if (!printed || /[\r\n]/.test(printed)) return;
  const output = path.resolve(path.dirname(input), printed);
  if (samePath(output, input) || !await isFile(output)) return;
  // Only a file of the kind being processed (or an unknown one) can carry on; a stray path would break the steps after it.
  const kind = await detectKind(output, { signal: run.signal }).catch(() => undefined);
  if (!kind || kind === run.fileType) run.current = output;
}

/** `runShortcut(name)`: a script file of that name runs as `runScript`; there is no Shortcuts app to ask. */
export async function runShortcut(run: RunState, name: string) {
  const script = path.resolve(path.dirname(run.current), run.resolve(name));
  if (!await isFile(script)) throw new Error(`"${name}" is a macOS Shortcut, and Windows has no Shortcuts app. Use runScript with a script instead.`);
  return runScript(run, { path: script }, 'runShortcut');
}

/** `handleCopyToClipboard`: the path, the image itself, or a Markdown link, with `relativeTo` taken off the front of the path. */
export async function copyToClipboard(run: RunState, { format, relativeTo }: StepParamMap['copyToClipboard']) {
  const file = run.current;
  const shown = relativeTo === undefined ? file : file.replaceAll(run.resolve(relativeTo), '');
  if (format === 'imageData' && run.fileType === 'image') await run.opts.effects.copyToClipboard({ image: file });
  // Markdown links use forward slashes, which every renderer reads.
  else if (format === 'markdown') await run.opts.effects.copyToClipboard({ text: `[${path.parse(file).name}](${shown.replaceAll('\\', '/')})` });
  else await run.opts.effects.copyToClipboard({ text: shown });
  await run.mark(file);
}

/** Whether a later step would overwrite, move or delete the current file, so a fork has to keep its own copy. */
function forkNeedsCopy(following: PipelineStep[]) {
  return following.some(step => {
    const [kind] = stepEntry(step);
    if (kind === 'delete' || kind === 'move' || kind === 'rename') return true;
    if (kind === 'convert') return stepLocation(step) === 'inPlace';
    return ['optimise', 'downscale', 'lowerBitrate', 'crop', 'targetSize', 'stripExif', 'watermark', 'capFps', 'normalize', 'removeAudio', 'changeSpeed'].includes(kind) && (stepLocation(step) ?? 'inPlace') === 'inPlace';
  });
}

/**
 * `handleFork`: hands back the result so far as a second result, leaving the file the pipeline carries on with alone. With a
 * location it is saved there; otherwise it is the current file itself, or a temporary copy when a later step would change it.
 */
export async function fork(run: RunState, location: string | undefined, following: PipelineStep[]) {
  const source = run.current;
  const info = await stat(source).catch(() => undefined);
  if (!info?.isFile() || !info.size || !await detectKind(source, { signal: run.signal }).catch(() => undefined)) return;
  const copy = async () => copyTo(source, path.join(await run.scratch(), path.basename(source)));
  let file = source;
  if (location && location !== 'temporaryFolder' && location !== 'inPlace') file = await applyLocation(run, location, await copy(), run.original);
  else if (forkNeedsCopy(following)) file = await copy();
  run.forks.push(file);
}
