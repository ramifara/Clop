import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { encodeMessage, LineReader, parseServerMessage, pipeInfoFile, validProof, type ClientMessage, type PipeEndpoint, type PipeInfo, type ServerMessage } from './protocol';

// The client side of the pipe, shared by the CLI and the MCP server. Every connection starts with the `hello` handshake,
// so a request only ever goes to the app that wrote `ipc.json`.

/** The app is not running, or not listening: the caller runs the request headless instead. */
export class AppNotRunning extends Error { override name = 'AppNotRunning'; constructor() { super('Clop is not running.'); } }
/** Something answers on the published pipe but cannot prove it is the app: a stale name someone else took over. Nothing was sent to it. */
export class ForgedServer extends Error { override name = 'ForgedServer'; constructor() { super('The pipe Clop published is answered by something that is not Clop, so nothing was sent to it.'); } }

/** Where the running app said it listens, with its key, or undefined when it published nothing. */
export async function appPipe(userData: string): Promise<PipeEndpoint | undefined> {
  try {
    const info = JSON.parse(await readFile(pipeInfoFile(userData), 'utf8')) as Partial<PipeInfo>;
    return typeof info.pipe === 'string' && info.pipe && typeof info.key === 'string' && info.key ? { pipe: info.pipe, key: info.key } : undefined;
  } catch { return undefined; }
}

const NOT_LISTENING = new Set(['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ECONNRESET', 'EACCES', 'EPERM']);

interface Connection { socket: net.Socket }

/**
 * Connects and runs the handshake. Resolves once the app proved itself; `onLine` then gets every later line. Rejects
 * with `AppNotRunning` when nothing listens and `ForgedServer` when the answer is wrong or never comes.
 */
function connect(endpoint: PipeEndpoint, onLine: (line: string) => void, timeoutMs: number): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(24).toString('base64');
    let connected = false, proven = false;
    const socket = net.connect(endpoint.pipe);
    const fail = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); };
    const timer = setTimeout(() => fail(connected ? new ForgedServer() : new AppNotRunning()), timeoutMs);
    const lines = new LineReader(line => {
      if (proven) return onLine(line);
      let proof: unknown;
      try { proof = (JSON.parse(line) as { hello?: unknown }).hello; } catch {}
      if (!validProof(endpoint.key, nonce, proof)) return fail(new ForgedServer());
      proven = true; clearTimeout(timer);
      resolve({ socket });
    });
    socket.on('connect', () => { connected = true; socket.write(`${JSON.stringify({ hello: nonce })}\n`); });
    socket.on('data', chunk => { try { lines.push(chunk); } catch (error) { if (proven) socket.destroy(error as Error); else fail(new ForgedServer()); } });
    socket.on('error', (error: NodeJS.ErrnoException) => { if (!proven) fail(!connected && NOT_LISTENING.has(error.code ?? '') ? new AppNotRunning() : error); });
    socket.once('close', () => { if (!proven) fail(connected ? new ForgedServer() : new AppNotRunning()); });
  });
}

/** Whether the app answers on `endpoint`. Rejects with `ForgedServer` when something answers that cannot prove it is the app. */
export async function appAnswers(endpoint: PipeEndpoint, timeoutMs = 2000): Promise<boolean> {
  try { (await connect(endpoint, () => {}, timeoutMs)).socket.destroy(); return true; } catch (error) { if (error instanceof AppNotRunning) return false; throw error; }
}

/**
 * Sends one message and calls `onMessage` for each answer line until the app closes the connection. Rejects with
 * `AppNotRunning` when nothing listens on the pipe, `ForgedServer` when the listener is not the app, and with the app's
 * words for a `failed` answer. `signal` closes the connection; the app keeps working on what it was sent, as macOS does
 * for a CLI that goes away.
 */
export async function sendMessage(endpoint: PipeEndpoint, message: ClientMessage, onMessage: (message: ServerMessage) => void = () => {}, { connectTimeoutMs = 3000, signal }: { connectTimeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  let failure: Error | undefined, protocolError: Error | undefined;
  const { socket } = await connect(endpoint, line => {
    try {
      const answer = parseServerMessage(line);
      if (answer.kind === 'failed') failure ??= new Error(answer.error); else onMessage(answer);
    } catch (error) { protocolError ??= error as Error; socket.destroy(); }
  }, connectTimeoutMs);
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => { signal?.removeEventListener('abort', abort); socket.destroy(); error ? reject(error) : resolve(); };
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('Cancelled.'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', error => finish(protocolError ?? error));
    socket.on('close', () => finish(protocolError ?? failure));
    socket.write(encodeMessage(message));
  });
}

/** Sends one message without waiting for its answers (`--async`). Resolves once it is written; the app works on regardless. */
export async function postMessage(endpoint: PipeEndpoint, message: ClientMessage): Promise<void> {
  const { socket } = await connect(endpoint, () => {}, 3000);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.end(encodeMessage(message), () => { socket.destroy(); resolve(); });
  });
}
