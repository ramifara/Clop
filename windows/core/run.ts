import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { toolArguments } from './longpath';
import { TOOL_NAMES, toolPath, type ToolName } from './tools';

export interface RunOptions {
  signal?: AbortSignal; cwd?: string; input?: Buffer; timeoutMs?: number; onStderrLine?: (line: string) => void; onStdoutLine?: (line: string) => void; env?: NodeJS.ProcessEnv;
  /** Windows only: pass the arguments unquoted, for `cmd.exe /s /c "…"`, which parses its own quotes. */
  windowsVerbatimArguments?: boolean;
}
export interface RunResult { code: number; stdout: Buffer; stderr: string }
export class ToolError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string) { super(message); this.name = 'ToolError'; }
}

const STDERR_LIMIT = 1024 * 1024;
const isToolName = (tool: string): tool is ToolName => (TOOL_NAMES as readonly string[]).includes(tool);
// ffmpeg's `-progress` key=value lines, which would push its actual error out of the last lines.
const PROGRESS_LINE = /^(frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time(_us|_ms)?|dup_frames|drop_frames|speed|progress)=\s*\S*$/;
export const lastLines = (text: string, count: number) => text.split(/\r?\n|\r/).map(line => line.trim()).filter(line => line && !PROGRESS_LINE.test(line)).slice(-count).join('\n');
const abortError = (signal: AbortSignal) => signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');

/** Kills the process and everything it started. Windows has no process groups or SIGTERM, so taskkill walks the tree. */
export function killTree(child: ChildProcess) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawn(taskkill, ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

/**
 * Runs a tool below the priority of the apps the user is working in, so a batch that keeps every core busy still leaves the
 * desktop responsive. Windows only: on an idle machine the tools get the whole CPU as before, and when another program wants a
 * core, it goes first. A process that ended before this is asked is not an error.
 */
export function lowerPriority(child: ChildProcess) {
  if (process.platform !== 'win32' || child.pid === undefined) return;
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Already gone, or not ours to change. */ }
}

/** Splits streamed text into lines. Progress output such as ffmpeg's and gifski's ends lines with a bare carriage return. */
function lineSplitter(emit: (line: string) => void) {
  let pending = '';
  return {
    push(chunk: string) {
      const lines = (pending + chunk).split(/\r\n|\r|\n/);
      pending = lines.pop()!;
      for (const line of lines) if (line) emit(line);
    },
    flush() { if (pending) emit(pending); pending = ''; },
  };
}

export function run(tool: ToolName | string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { signal, timeoutMs, onStderrLine, onStdoutLine } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const command = isToolName(tool) ? toolPath(tool) : tool;
    const name = path.basename(command);
    // Never the folder Clop happened to start in (an Explorer verb starts it in the selected file's folder, such as Downloads),
    // where a tool could find a DLL someone left there: the tool's own folder, or Clop's, unless the caller chose one.
    const cwd = opts.cwd ?? (path.isAbsolute(command) ? path.dirname(command) : path.dirname(process.execPath));
    // A detached child leads its own process group on POSIX, so the whole tree can be killed at once.
    const child = spawn(command, isToolName(tool) ? toolArguments(tool, args) : args, { cwd, env: opts.env, windowsHide: true, windowsVerbatimArguments: opts.windowsVerbatimArguments, detached: process.platform !== 'win32', stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    lowerPriority(child);
    const stdout: Buffer[] = [];
    let stderr = '', failure: Error | undefined, timer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => { failure ??= error; killTree(child); };
    const onAbort = () => stop(abortError(signal!));
    signal?.addEventListener('abort', onAbort, { once: true });
    // A throwing progress callback fails the run instead of escaping as an uncaught exception from the stream.
    const emitter = (callback?: (line: string) => void) => (line: string) => { if (failure) return; try { callback?.(line); } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); } };
    const stderrLines = lineSplitter(emitter(onStderrLine)), stdoutLines = lineSplitter(emitter(onStdoutLine)), stdoutText = new StringDecoder('utf8');
    if (timeoutMs) timer = setTimeout(() => stop(new ToolError(`${name} took too long and was stopped.`, null, lastLines(stderr, 5))), timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => { stdout.push(chunk); if (onStdoutLine) stdoutLines.push(stdoutText.write(chunk)); });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      if (onStderrLine) stderrLines.push(chunk);
    });
    child.stdin?.on('error', () => {}).end(opts.input);
    child.on('error', error => { failure ??= error; });
    child.on('close', (code, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stderrLines.flush(); stdoutLines.flush();
      if (failure) return reject(failure);
      if (code === 0) return resolve({ code, stdout: Buffer.concat(stdout), stderr });
      const detail = lastLines(stderr, 5);
      reject(new ToolError(`${name} ${code === null ? `was stopped by ${killedBy}` : `exited with code ${code}`}${detail ? `:\n${detail}` : ''}`, code, detail));
    });
  });
}

export type QueueKind = 'image' | 'video' | 'pdf' | 'audio';
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;
/** How many files of each kind run at once. */
export const CONCURRENCY: Record<QueueKind, number> = { image: 2, video: 1, pdf: 2, audio: 2 };
const limiters = new Map<QueueKind, Limiter>();

/** Runs at most `max` tasks at once; the rest wait in order. */
export function limiter(max: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  // A finishing task hands its slot straight to the next waiter, so the count never exceeds max.
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
  return async task => {
    if (active < max) active++; else await new Promise<void>(resolve => waiting.push(resolve));
    try { return await task(); } finally { release(); }
  };
}

/** One shared limiter per media type, so heavy encoders don't all run at once. */
export function queue(kind: QueueKind): Limiter {
  let limit = limiters.get(kind);
  if (!limit) limiters.set(kind, limit = limiter(CONCURRENCY[kind]));
  return limit;
}

/** Retries file operations that Defender, indexers or preview handlers briefly lock. */
export async function retryBusy<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1, wait = 100; ; attempt++, wait *= 2) {
    try { return await fn(); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EBUSY' && code !== 'EPERM')) throw error;
      await delay(wait);
    }
  }
}
