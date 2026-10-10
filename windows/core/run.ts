import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TOOL_NAMES, toolPath, type ToolName } from './tools';

export interface RunOptions { signal?: AbortSignal; cwd?: string; input?: Buffer; timeoutMs?: number; onStderrLine?: (line: string) => void; env?: NodeJS.ProcessEnv }
export interface RunResult { code: number; stdout: Buffer; stderr: string }
export class ToolError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string) { super(message); this.name = 'ToolError'; }
}

const STDERR_LIMIT = 1024 * 1024;
const isToolName = (tool: string): tool is ToolName => (TOOL_NAMES as readonly string[]).includes(tool);
const lastLines = (text: string, count: number) => text.split(/\r?\n|\r/).map(line => line.trim()).filter(Boolean).slice(-count).join('\n');
const abortError = (signal: AbortSignal) => signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');

/** Kills the process and everything it started. Windows has no process groups or SIGTERM, so taskkill walks the tree. */
function killTree(child: ChildProcess) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawn(taskkill, ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

export function run(tool: ToolName | string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { signal, timeoutMs, onStderrLine } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const command = isToolName(tool) ? toolPath(tool) : tool;
    const name = path.basename(command);
    // A detached child leads its own process group on POSIX, so the whole tree can be killed at once.
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, detached: process.platform !== 'win32', stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '', pending = '', failure: Error | undefined, timer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => { failure ??= error; killTree(child); };
    const onAbort = () => stop(abortError(signal!));
    signal?.addEventListener('abort', onAbort, { once: true });
    // A throwing progress callback fails the run instead of escaping as an uncaught exception from the stream.
    const emit = (line: string) => { if (failure) return; try { onStderrLine?.(line); } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); } };
    if (timeoutMs) timer = setTimeout(() => stop(new ToolError(`${name} took too long and was stopped.`, null, lastLines(stderr, 5))), timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      if (!onStderrLine) return;
      // Progress output such as ffmpeg's ends lines with a bare carriage return.
      const lines = (pending + chunk).split(/\r\n|\r|\n/);
      pending = lines.pop()!;
      for (const line of lines) if (line) emit(line);
    });
    child.stdin?.on('error', () => {}).end(opts.input);
    child.on('error', error => { failure ??= error; });
    child.on('close', (code, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (pending) emit(pending);
      if (failure) return reject(failure);
      if (code === 0) return resolve({ code, stdout: Buffer.concat(stdout), stderr });
      const detail = lastLines(stderr, 5);
      reject(new ToolError(`${name} ${code === null ? `was stopped by ${killedBy}` : `exited with code ${code}`}${detail ? `:\n${detail}` : ''}`, code, detail));
    });
  });
}

export type QueueKind = 'image' | 'video' | 'pdf' | 'audio';
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;
const CONCURRENCY: Record<QueueKind, number> = { image: 2, video: 1, pdf: 2, audio: 2 };
const limiters = new Map<QueueKind, Limiter>();

function limiter(max: number): Limiter {
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
