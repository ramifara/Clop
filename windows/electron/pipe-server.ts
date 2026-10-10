import { rmSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { encodeMessage, LineReader, parseClientMessage, pipeInfoFile, type ClientMessage, type ServerMessage } from '../core/ipc/protocol';

// The app's end of the pipe (spec step 24). One request per connection: the first line is the request, the answers go
// back as lines, and the connection closes when the handler is done. A client that disconnects early does not stop the
// work, as on macOS; it sends a stop request for that.
//
// Security: on Windows Node creates the pipe with the default security descriptor, whose DACL grants write access only
// to the creating user, SYSTEM and Administrators; everyone else may only open it for reading, which cannot deliver a
// request. The name is random and published in the user's own app data folder, so another user cannot guess it to
// squat it, and the first instance flag Node sets makes the app refuse a name someone else already holds.

export type PipeHandler = (message: ClientMessage, emit: (message: ServerMessage) => void) => Promise<void>;

export interface PipeServer { path: string; close(): Promise<void> }

/** Listens on `pipePath`. A Unix socket off Windows is only reachable by the user (mode 0600 on a fresh name). */
export async function startPipeServer(pipePath: string, handler: PipeHandler): Promise<PipeServer> {
  const connections = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    let started = false;
    // A connection that never sends its request is dropped; once the request runs, it may take as long as it needs.
    socket.setTimeout(30_000, () => { if (!started) socket.destroy(); });
    const emit = (message: ServerMessage) => { if (!socket.destroyed && socket.writable) socket.write(encodeMessage(message)); };
    const reader = new LineReader(line => {
      if (started) return;
      started = true;
      socket.setTimeout(0);
      let message: ClientMessage;
      try { message = parseClientMessage(line); } catch (error) { emit({ kind: 'failed', error: (error as Error).message }); socket.end(); return; }
      handler(message, emit).catch(error => emit({ kind: 'failed', error: error instanceof Error ? error.message : String(error) })).finally(() => socket.end());
    });
    socket.on('data', chunk => {
      try { reader.push(chunk); } catch (error) { emit({ kind: 'failed', error: (error as Error).message }); socket.destroy(); }
    });
  });
  if (process.platform !== 'win32') await rm(pipePath, { force: true });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipePath, () => { server.off('error', reject); resolve(); }); });
  server.on('error', () => {});
  if (process.platform !== 'win32') await chmod(pipePath, 0o600);
  return {
    path: pipePath,
    close: () => new Promise(resolve => { for (const socket of connections) socket.destroy(); server.close(() => resolve()); }),
  };
}

/** Publishes where the app listens, for the CLI and the MCP server. Returns a function that withdraws it, synchronously so it can run while the app quits. */
export async function publishPipe(userData: string, pipePath: string): Promise<() => void> {
  const file = pipeInfoFile(userData);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ pipe: pipePath, pid: process.pid }));
  return () => rmSync(file, { force: true });
}
