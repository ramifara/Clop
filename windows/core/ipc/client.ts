import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { encodeMessage, LineReader, parseServerMessage, pipeInfoFile, type ClientMessage, type PipeInfo, type ServerMessage } from './protocol';

// The client side of the pipe, shared by the CLI and the MCP server.

/** The app is not running, or not listening: the caller runs the request headless instead. */
export class AppNotRunning extends Error { override name = 'AppNotRunning'; constructor() { super('Clop is not running.'); } }

/** The pipe the running app published, or undefined when there is none. */
export async function appPipe(userData: string): Promise<string | undefined> {
  try {
    const info = JSON.parse(await readFile(pipeInfoFile(userData), 'utf8')) as Partial<PipeInfo>;
    return typeof info.pipe === 'string' && info.pipe ? info.pipe : undefined;
  } catch { return undefined; }
}

const NOT_LISTENING = new Set(['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ECONNRESET', 'EACCES', 'EPERM']);

/**
 * Sends one message and calls `onMessage` for each answer line until the app closes the connection. Rejects with
 * `AppNotRunning` when nothing listens on `pipe`, and with the app's words for a `failed` answer. `signal` closes the
 * connection; the app keeps working on what it was sent, as macOS does for a CLI that goes away.
 */
export function sendMessage(pipe: string, message: ClientMessage, onMessage: (message: ServerMessage) => void = () => {}, { connectTimeoutMs = 3000, signal }: { connectTimeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let connected = false, settled = false, failure: Error | undefined;
    const socket = net.connect(pipe);
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); error ? reject(error) : resolve(); };
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('Cancelled.'));
    const timer = setTimeout(() => finish(new AppNotRunning()), connectTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const reader = new LineReader(line => {
      const answer = parseServerMessage(line);
      if (answer.kind === 'failed') failure ??= new Error(answer.error);
      else onMessage(answer);
    });
    socket.on('connect', () => { connected = true; clearTimeout(timer); socket.write(encodeMessage(message)); });
    socket.on('data', chunk => { try { reader.push(chunk); } catch (error) { finish(error as Error); } });
    socket.on('error', (error: NodeJS.ErrnoException) => finish(!connected && NOT_LISTENING.has(error.code ?? '') ? new AppNotRunning() : error));
    socket.on('end', () => finish(failure));
    socket.on('close', () => finish(failure ?? (connected ? undefined : new AppNotRunning())));
  });
}

/** Sends one message without waiting for its answers (`--async`). Resolves once it is written; the app works on regardless. */
export function postMessage(pipe: string, message: ClientMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe, () => socket.end(encodeMessage(message), () => { socket.destroy(); resolve(); }));
    socket.on('error', (error: NodeJS.ErrnoException) => reject(NOT_LISTENING.has(error.code ?? '') ? new AppNotRunning() : error));
  });
}
