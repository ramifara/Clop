import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

/** The scheme the crop and compare windows load originals, results and their previews from. */
export const MEDIA_SCHEME = 'clop-media';
const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff',
};
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };

/**
 * The files the windows may load. The renderer never names a path: the main process hands out an opaque token for each file it
 * allows, and only files under `roots` (the session's originals, results and previews) can get one. Requests take byte ranges,
 * so videos seek without loading whole.
 */
export class MediaFiles {
  private tokens = new Map<string, string>();
  private paths = new Map<string, string>();
  private roots: string[];
  /** `base` is what URLs start with: `clop-media://file/` in the app, a path on the dev server in the browser preview. */
  constructor(roots: string[], private base = `${MEDIA_SCHEME}://file/`) { this.roots = roots.map(root => path.resolve(root)); }
  /** The URL of `file`, the same one each time. Throws for a file outside the roots. */
  url(file: string) {
    const resolved = path.resolve(file);
    if (!this.roots.some(root => inside(root, resolved))) throw new Error(`${path.basename(file)} is not a file of this session.`);
    let token = this.paths.get(resolved);
    if (!token) { token = randomUUID(); this.tokens.set(token, resolved); this.paths.set(resolved, token); }
    return this.base + token;
  }
  /** Forgets the files under `dir`, a dismissed result's folder. */
  revoke(dir: string) {
    const resolved = path.resolve(dir);
    for (const [file, token] of this.paths) if (file === resolved || inside(resolved, file)) { this.paths.delete(file); this.tokens.delete(token); }
  }
  /** Answers a GET or HEAD for a token's URL, honouring a `Range` header. */
  async handle(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const token = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? ''), file = this.tokens.get(token);
    // A link inside the session is never followed out of it.
    const real = file && await realpath(file).catch(() => undefined), roots = await Promise.all(this.roots.map(root => realpath(root).catch(() => root)));
    const info = real && roots.some(root => inside(root, real)) ? await stat(real).catch(() => undefined) : undefined;
    if (!real || !info?.isFile()) return new Response(null, { status: 404 });
    const headers = new Headers({ 'Content-Type': TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const range = byteRange(request.headers.get('range'), info.size);
    if (range === 'invalid') { headers.set('Content-Range', `bytes */${info.size}`); return new Response(null, { status: 416, headers }); }
    const { start, end } = range ?? { start: 0, end: info.size - 1 };
    headers.set('Content-Length', String(Math.max(0, end - start + 1)));
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
    const body = request.method === 'HEAD' || end < start ? null : Readable.toWeb(createReadStream(real, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(body, { status: range ? 206 : 200, headers });
  }
}

/** A single `bytes=` range of a `size`-byte file; undefined without one, `invalid` when it cannot be served. Several ranges get the whole file. */
export function byteRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return undefined;
  const [, from, to] = match;
  if (!from && !to) return 'invalid';
  if (!from) { const length = Number(to); return length > 0 && size > 0 ? { start: Math.max(0, size - length), end: size - 1 } : 'invalid'; }
  const start = Number(from), end = to ? Math.min(Number(to), size - 1) : size - 1;
  return start < size && start <= end ? { start, end } : 'invalid';
}
