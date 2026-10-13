import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { constants, gunzipSync } from 'node:zlib';
import { extendedPath } from '../longpath';

/** The largest SVG Clop opens: libvips refuses larger ones unless told to drop its safety limits. */
export const SVG_LIMIT = 10 * 1024 * 1024;
/** How far into a file libvips looks for `<svg`. */
const HEAD = 1000;

export class SVGTooLargeError extends Error {
  constructor(file: string) { super(`${path.basename(file)} is an SVG larger than ${SVG_LIMIT / 1024 / 1024} MB, which Clop does not open.`); this.name = 'SVGTooLargeError'; }
}

/** Whether a file's first bytes are an SVG by libvips' test: `<svg`, in any case, within the first 1000 bytes, also inside gzip (SVGZ). */
export function looksLikeSVG(head: Buffer): boolean {
  let text = head.subarray(0, HEAD);
  if (text.length >= 18 && text[0] === 0x1f && text[1] === 0x8b) {
    // The head is only the start of the stream: a sync flush inflates what is there without asking for the rest.
    try { text = gunzipSync(text, { finishFlush: constants.Z_SYNC_FLUSH }).subarray(0, HEAD); } catch { return false; }
  }
  return /<svg/i.test(text.toString('latin1'));
}

/**
 * What to hand sharp for `file`: an SVG's bytes, read here, or else its path (with the prefix past MAX_PATH, as libvips opens it).
 * Given a path, librsvg opens an SVG itself through GLib, which on Windows makes the handle inheritable and does not share
 * deletion: a tool that Clop starts meanwhile keeps the file open, and until that tool exits the file can be neither renamed nor
 * deleted. Node's own reads leave nothing behind. An SVG over `SVG_LIMIT` fails with `SVGTooLargeError`.
 */
export async function sharpInput(file: string): Promise<string | Buffer> {
  const handle = await open(file, 'r');
  let size: number, head: Buffer;
  try {
    size = (await handle.stat()).size;
    head = Buffer.alloc(Math.min(HEAD, size));
    await handle.read(head, 0, head.length, 0);
  } finally { await handle.close(); }
  if (!looksLikeSVG(head)) return extendedPath(file);
  if (size > SVG_LIMIT) throw new SVGTooLargeError(file);
  return readFile(file);
}
