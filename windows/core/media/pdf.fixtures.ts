import type { TestContext } from 'node:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { degrees, PDFDocument } from '@cantoo/pdf-lib';
import { needTools } from '../testing';
import { toolPath } from '../tools';
import { findPaperSize } from '../data/paperSizes';
import { photo } from './image.fixtures';

// Test PDFs generated with pdf-lib, so no PDF fixture is committed.
export const LETTER: [number, number] = [612, 792];
const a4 = findPaperSize('A4')!;
export const A4_RATIO = a4.width / a4.height;

export async function workspace(t: TestContext, ...tools: Parameters<typeof needTools>[1][]) {
  if (tools.length && !needTools(t, ...tools)) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-pdf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, out: path.join(dir, 'out'), file: async (name: string, data: Uint8Array) => { const target = path.join(dir, name); await writeFile(target, data); return target; } };
}

/** A PDF of `pages` pages, each filled with the same photo, so every page holds one image at `dpi`. */
export async function photoPDF({ pages = 4, page = [288, 216] as [number, number], dpi = 285, seed = 1 } = {}) {
  const doc = await PDFDocument.create();
  const jpeg = await doc.embedJpg(await photo(Math.round(page[0] / 72 * dpi), Math.round(page[1] / 72 * dpi), seed).jpeg({ quality: 95 }).toBuffer());
  for (let i = 0; i < pages; i++) doc.addPage(page).drawImage(jpeg, { x: 0, y: 0, width: page[0], height: page[1] });
  return doc.save();
}
/** Text-only pages; `width(i)` sets page i's width so page order can be checked after a round trip. */
export async function textPDF(pages: number, { size = LETTER, width = (_: number) => size[0], rotate = 0 } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([width(i), size[1]]);
    page.drawText(`Page ${i + 1}`, { x: 40, y: size[1] - 80, size: 28 });
    if (rotate) page.setRotation(degrees(rotate));
  }
  return doc.save();
}
export const boxes = async (file: string) => (await PDFDocument.load(await readFile(file))).getPages().map(p => ({ media: p.getMediaBox(), crop: p.getCropBox() }));
export const round = (box: { x: number; y: number; width: number; height: number }) => Object.fromEntries(Object.entries(box).map(([k, v]) => [k, Math.round(v * 100) / 100]));
export const leftovers = async (dir: string) => (await readdir(dir)).filter(name => name.startsWith('.clop-') || name.endsWith('.partial'));

/**
 * Puts a logging `gs` in front of the real one through CLOP_TOOLS_DIR, so a test can see how many Ghostscript processes ran
 * and overlapped. Its first `fail` runs report two pages, then exit with an error. POSIX shell only; the caller skips it on Windows.
 */
// Resolved before any wrapper takes over CLOP_TOOLS_DIR, so wrappers never call each other.
let realGs: string | undefined;
export async function wrapGhostscript(t: TestContext, dir: string, fail = 0) {
  realGs ??= toolPath('gs');
  const bin = path.join(dir, 'gs-wrapper'), log = path.join(dir, 'gs.log'), count = path.join(dir, 'gs.count');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'gs'), [
    '#!/bin/sh',
    `echo start >> '${log}'`,
    `n=$(cat '${count}' 2>/dev/null || echo 0); echo $((n + 1)) > '${count}'`,
    `if [ "$n" -lt ${fail} ]; then printf 'Page 1\\nPage 2\\nsimulated Ghostscript failure\\n' >&2; echo end >> '${log}'; exit 1; fi`,
    `'${realGs}' "$@"; code=$?`,
    `echo end >> '${log}'`,
    'exit $code',
  ].join('\n'));
  await chmod(path.join(bin, 'gs'), 0o755);
  const previous = process.env.CLOP_TOOLS_DIR;
  process.env.CLOP_TOOLS_DIR = bin;
  t.after(() => { if (previous === undefined) delete process.env.CLOP_TOOLS_DIR; else process.env.CLOP_TOOLS_DIR = previous; });
  const events = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return {
    starts: async () => (await events()).filter(e => e === 'start').length,
    /** The most processes that were running at the same time. */
    peak: async () => { let running = 0, peak = 0; for (const e of await events()) peak = Math.max(peak, running += e === 'start' ? 1 : -1); return peak; },
  };
}
