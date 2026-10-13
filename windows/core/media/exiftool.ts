import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { killTree, lastLines, lowerPriority, run, ToolError, type RunResult } from '../run';
import { executableName, toolPath } from '../tools';

// ExifTool is a Perl program: on Windows the bundled build spends most of a second starting, and Clop runs it for every result it
// optimises, often for two per image. `-stay_open` keeps one process waiting for commands on its standard input, each ended by
// `-execute`, so a command costs what the work itself costs. Commands run one after another, as the tool reads them. exiftool does
// not end when its input closes, so a process left idle ends itself after a while, and the app notes the process' id in a file
// (`recordExifToolPid`): one that outlived a Clop that could not close it (a crash, a forced end) would otherwise keep polling, and
// keep its exe open for an installer, until the next start ends it (`endStaleExifTool`).

const READY = /^\{ready(\d+)\}\r?$/;
const STATUS = /^\{clop-status=(-?\d+)\}\r?$/;
const DONE = /\{clop-done(\d+)\}\r?\n/;
const STDERR_LIMIT = 64 * 1024;
/** How long the process may be left alone before a crashed one is started again. */
const RESTART_AFTER_MS = 30_000;
/** How long a command may take before the process is given up as stuck; a process of its own has no limit, so this is only for one that hangs. */
const COMMAND_TIMEOUT_MS = 5 * 60_000;
/** How long the process waits for a command before ending itself. The next command starts one again. */
let idleMs = 30_000;

/** `ready` and `done` arrive on different pipes, in no fixed order; the answer waits for both, so its stderr is all there. */
interface Pending { id: number; out: string[]; err: string; status?: number; ready?: boolean; done?: boolean; resolve: (result: RunResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

const abortError = (signal: AbortSignal) => signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');

class ExifToolProcess {
  private child: ChildProcess;
  private queue: Promise<unknown> = Promise.resolve();
  private next = 1;
  private pending?: Pending;
  private buffer = '';
  private errors = '';
  private idle?: NodeJS.Timeout;
  /** Set once the process is gone or going: later commands run on their own. */
  dead = false;
  readonly exited: Promise<void>;

  constructor(private readonly onIdle: (process: ExifToolProcess) => void) {
    const exe = toolPath('exiftool');
    // The process' own folder, like every tool Clop starts (see `run`); every path a command names is absolute.
    this.child = spawn(exe, ['-stay_open', 'True', '-@', '-'], { cwd: path.dirname(exe), windowsHide: true, stdio: 'pipe' });
    lowerPriority(this.child);
    // Idle, neither the process nor its pipes keep Clop alive.
    this.hold(false);
    this.child.stdout!.setEncoding('utf8').on('data', (chunk: string) => this.read(chunk));
    this.child.stderr!.setEncoding('utf8').on('data', (chunk: string) => this.readError(chunk));
    this.child.stdin!.on('error', () => {});
    this.exited = new Promise(resolve => {
      const gone = (error?: Error) => { this.dead = true; this.fail(error ?? new Error('exiftool stopped.')); resolve(); };
      // A process that could not start is gone; a later error (a failed kill) is not the end of a running one.
      this.child.on('error', error => { if (this.child.pid === undefined) gone(error); });
      // `close`, not `exit`: the pipes are drained by then, so a command the process answered just before ending gets its answer.
      this.child.on('close', () => gone());
    });
    this.rest();
  }

  get pid() { return this.child.pid; }

  /** Whether the process and its pipes keep the event loop alive: only while a command is under way, so a command is always answered. */
  private hold(busy: boolean) {
    for (const handle of [this.child, this.child.stdin, this.child.stdout, this.child.stderr]) (handle as unknown as { ref?: () => void; unref?: () => void } | null)?.[busy ? 'ref' : 'unref']?.();
  }

  /** Starts the idle clock: with no command for `idleMs`, the process ends. */
  private rest() {
    clearTimeout(this.idle);
    if (this.dead) return;
    this.idle = setTimeout(() => { if (!this.pending && !this.dead) this.onIdle(this); }, idleMs);
    this.idle.unref();
  }

  /** Whether a command can still be sent. */
  get alive() { return !this.dead && this.child.exitCode === null && !this.child.killed && !!this.child.stdin?.writable; }

  /** Runs one command, after those before it. Rejects with a `ToolError` when exiftool reports a failure, as `run` does. */
  run(args: string[], signal?: AbortSignal): Promise<RunResult> {
    const send = () => this.send(args, signal);
    const result = this.queue.then(send, send);
    this.queue = result.catch(() => {});
    return result;
  }

  private send(args: string[], signal?: AbortSignal) {
    return new Promise<RunResult>((resolve, reject) => {
      // Cancelled while it waited its turn: not sent at all.
      if (signal?.aborted) return reject(abortError(signal));
      if (!this.alive) return reject(new Error('exiftool stopped.'));
      clearTimeout(this.idle);
      const id = this.next++;
      const timer = setTimeout(() => { this.dead = true; killTree(this.child); this.fail(new ToolError('exiftool took too long and was stopped.', null, '')); }, COMMAND_TIMEOUT_MS);
      timer.unref();
      this.pending = { id, out: [], err: '', resolve, reject, timer };
      this.hold(true);
      // One argument per line, as an argfile: nothing is quoted or split. After the command, the status echoes to stdout before
      // `{ready}`, and a mark echoes to stderr after whatever the command wrote there.
      // eslint-disable-next-line no-template-curly-in-string
      this.child.stdin!.write([...args, '-echo3', '{clop-status=${status}}', '-echo4', `{clop-done${id}}`, `-execute${id}`].join('\n') + '\n');
    });
  }

  private read(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop()!;
    for (const line of lines) {
      const pending = this.pending;
      if (!pending) continue;
      const ready = READY.exec(line), status = STATUS.exec(line);
      if (status) { pending.status = Number(status[1]); continue; }
      if (!ready || Number(ready[1]) !== pending.id) { pending.out.push(line.endsWith('\r') ? line.slice(0, -1) : line); continue; }
      pending.ready = true;
      this.settle(pending);
    }
  }

  private readError(chunk: string) {
    const pending = this.pending;
    if (!pending) return;
    this.errors += chunk;
    const done = DONE.exec(this.errors);
    if (!done) { this.errors = this.errors.slice(-STDERR_LIMIT); return; }
    pending.err = (pending.err + this.errors.slice(0, done.index)).slice(-STDERR_LIMIT);
    this.errors = this.errors.slice(done.index + done[0].length);
    if (Number(done[1]) === pending.id) { pending.done = true; this.settle(pending); }
  }

  private settle(pending: Pending) {
    if (!pending.ready || !pending.done) return;
    this.pending = undefined;
    this.errors = '';
    clearTimeout(pending.timer);
    this.hold(false);
    this.rest();
    const code = pending.status ?? 0, stderr = pending.err.trim();
    if (code === 0) pending.resolve({ code, stdout: Buffer.from(pending.out.join('\n')), stderr });
    else { const detail = lastLines(stderr, 5); pending.reject(new ToolError(`exiftool exited with code ${code}${detail ? `:\n${detail}` : ''}`, code, detail)); }
  }

  private fail(error: Error) {
    const pending = this.pending;
    this.pending = undefined;
    this.errors = '';
    clearTimeout(this.idle);
    this.hold(false);
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
  }

  /** Asks the process to end, then makes sure it has. A command under way is answered first. */
  async close() {
    this.dead = true;
    clearTimeout(this.idle);
    // Waited for, so a script that ends by closing is not over before the process is.
    this.hold(true);
    try { this.child.stdin!.end('-stay_open\nFalse\n'); } catch { /* Already gone. */ }
    const timer = setTimeout(() => killTree(this.child), 2000);
    timer.unref();
    await this.exited;
    clearTimeout(timer);
    this.hold(false);
  }
}

let current: ExifToolProcess | undefined, enabled = process.env.CLOP_EXIFTOOL_ONESHOT !== '1', failedAt = 0, hooked = false;
/** Processes ending on their own (idle), so quitting can wait for them too. */
const closing = new Set<Promise<void>>();
let pidFile: string | undefined;
const system32 = (exe: string) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);

/**
 * Where the app notes the waiting process' id, so a process that outlived a Clop that could not close it is ended at the next start
 * (`endStaleExifTool`). Only the app records one: a command-line run is short, and must not end the app's process.
 */
export function recordExifToolPid(file: string | undefined) { pidFile = file; }

/** Ends the process a previous run of the app noted and could not close (its id in `file`), when it is still an exiftool. */
export async function endStaleExifTool(file: string) {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return;
  await rm(file, { force: true });
  const pid = Number(text.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  // Process ids are reused, so only a process that is still exiftool is ended.
  if (await isExifTool(pid)) await endProcess(pid);
}

async function isExifTool(pid: number) {
  if (process.platform === 'win32') {
    const { stdout } = await run(system32('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 10_000 }).catch(() => ({ stdout: Buffer.alloc(0) }));
    return stdout.toString().toLowerCase().includes(`"${executableName('exiftool').toLowerCase()}"`);
  }
  const cmdline = await readFile(`/proc/${pid}/cmdline`, 'latin1').catch(() => '');
  return cmdline.includes('exiftool') && cmdline.includes('-stay_open');
}

async function endProcess(pid: number) {
  if (process.platform === 'win32') { await run(system32('taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { timeoutMs: 10_000 }).catch(() => {}); return; }
  try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
}

/** Whether exiftool is kept running between commands (the default) or started for each one. */
export function keepExifToolRunning(keep: boolean) {
  enabled = keep;
  if (!keep) void closeExifTool();
}

/** How long an idle process is kept, for tests. */
export function setExifToolIdleMs(ms: number) { idleMs = ms; }
/** Resolves when the process waiting now has ended; undefined when none is waiting. For tests. */
export function exifToolEnded(): Promise<void> | undefined { return current?.exited; }

function process_() {
  if (current?.alive) return current;
  current = undefined;
  if (Date.now() - failedAt < RESTART_AFTER_MS) return undefined;
  try {
    current = new ExifToolProcess(idle => {
      if (current === idle) current = undefined;
      const ended = idle.close().finally(() => closing.delete(ended));
      closing.add(ended);
    });
  } catch { failedAt = Date.now(); return undefined; }
  if (pidFile && current.pid !== undefined) void writeFile(pidFile, String(current.pid)).catch(() => {});
  if (!hooked) { hooked = true; process.once('exit', () => { void current?.close(); }); }
  return current;
}

/**
 * Runs an exiftool command and resolves with what it printed, through the waiting process when there is one, otherwise as a
 * process of its own. A failure exiftool reports rejects with a `ToolError`, as `run` does. A command already sent cannot be
 * stopped, so an abort is reported once the command is over; `cwd` sends the command to a process of its own.
 */
export async function exiftool(args: string[], { signal, cwd }: { signal?: AbortSignal; cwd?: string } = {}): Promise<RunResult> {
  if (signal?.aborted) throw abortError(signal);
  const shared = enabled && !cwd ? process_() : undefined;
  if (!shared) return run('exiftool', args, { signal, cwd });
  let result: RunResult;
  try { result = await shared.run(args, signal); } catch (error) {
    if (error instanceof ToolError || signal?.aborted) throw error;
    // The process went away under the command: this one runs on its own, and a new process waits after a pause.
    failedAt = Date.now();
    if (current === shared) current = undefined;
    return run('exiftool', args, { signal, cwd });
  }
  if (signal?.aborted) throw abortError(signal);
  return result;
}

/** Ends the waiting process, for quitting, and waits for one already ending on its own. The next command starts one again. */
export async function closeExifTool() {
  const waiting = current;
  current = undefined;
  if (waiting) await waiting.close();
  await Promise.all([...closing]);
  if (pidFile && !current) await rm(pidFile, { force: true }).catch(() => {});
}
