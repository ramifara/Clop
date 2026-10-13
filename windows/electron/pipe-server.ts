import { rmSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { encodeMessage, helloProof, LineReader, newPipeKey, parseClientMessage, parseHello, pipeInfoFile, type ClientMessage, type PipeInfo, type ServerMessage } from '../core/ipc/protocol';

// The app's end of the pipe (spec step 24). Each connection greets first (`hello`, answered with an HMAC under the
// key published in ipc.json, so the client knows it reached the app), then sends one request; the answers go back as
// lines and the connection closes when the handler is done. A client that disconnects early does not stop the work, as
// on macOS; it sends a stop request for that.
//
// Security: on Windows Node creates the pipe with the default security descriptor, whose DACL grants write access only
// to the creating user, SYSTEM and Administrators; everyone else may only open it for reading, which cannot deliver a
// greeting or a request. Node sets FILE_FLAG_FIRST_PIPE_INSTANCE, so the app never shares a name someone else holds.
// Node cannot set PIPE_REJECT_REMOTE_CLIENTS, so the same user (or an administrator) signed in over the network could
// connect too; that reaches no further than signing in locally. Pipe names can be listed by anyone, so the name is no
// secret: the handshake key, readable only through the user's profile, is what tells the CLI it reached the app.

export type PipeHandler = (message: ClientMessage, emit: (message: ServerMessage) => void) => Promise<void>;

export interface PipeServer { path: string; /** The handshake key, published with the path. */ key: string; close(): Promise<void> }

/** Listens on `pipePath`. A Unix socket off Windows is only reachable by the user (mode 0600 on a fresh name). */
export async function startPipeServer(pipePath: string, handler: PipeHandler, key = newPipeKey()): Promise<PipeServer> {
  const connections = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    let greeted = false, started = false;
    // A connection that never sends its request is dropped; once the request runs, it may take as long as it needs.
    socket.setTimeout(30_000, () => { if (!started) socket.destroy(); });
    const emit = (message: ServerMessage) => { if (!socket.destroyed && socket.writable) socket.write(encodeMessage(message)); };
    const reader = new LineReader(line => {
      if (started) return;
      if (!greeted) {
        let nonce: string;
        try { nonce = parseHello(line); } catch (error) { emit({ kind: 'failed', error: (error as Error).message }); socket.end(); started = true; return; }
        greeted = true;
        socket.write(`${JSON.stringify({ hello: helloProof(key, nonce) })}\n`);
        return;
      }
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
    path: pipePath, key,
    close: () => new Promise(resolve => { for (const socket of connections) socket.destroy(); server.close(() => resolve()); }),
  };
}

/**
 * Publishes where the app listens and its handshake key, for the CLI and the MCP server. The file is the user's alone (the
 * profile's ACL on Windows, mode 0600 elsewhere). Returns a function that withdraws it, synchronously so it can run while
 * the app quits.
 */
export async function publishPipe(userData: string, server: Pick<PipeServer, 'path' | 'key'>): Promise<() => void> {
  const file = pipeInfoFile(userData), info: PipeInfo = { pipe: server.path, pid: process.pid, key: server.key };
  await mkdir(path.dirname(file), { recursive: true });
  await rm(file, { force: true });
  await writeFile(file, JSON.stringify(info), { mode: 0o600 });
  return () => rmSync(file, { force: true });
}
