import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileURL } from '../core/ipc/protocol';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../core/media/detect';
import { resolveHome } from '../core/template';
import { ValidationError } from './args';
import type { Context } from './context';

// What the file commands take: files, folders and URLs (`validateItems` and `getURLsFromFolder` in ClopCLI/main.swift
// and Shared.swift), filtered by the `--types` and `--exclude-types` words.

/**
 * `refuseUnallowedMCPRequest`: an agent's request asks the gate; anyone else needs no permission. Asked before a path the agent
 * named is looked up, since looking up a network path sends the user's credentials to that server.
 */
export async function gate(ctx: Context, pipeline?: string) {
  if (ctx.origin !== 'mcp') return;
  const response = await (await ctx.backend()).settings({ action: 'gate', origin: ctx.origin, pipeline });
  if (!response.ok) throw new ValidationError(response.error ?? 'Clop refused the request.');
}

const SAME: Record<string, string[]> = { jpeg: ['jpg', 'jpeg', 'jpe'], jpg: ['jpg', 'jpeg', 'jpe'], tiff: ['tif', 'tiff'], tif: ['tif', 'tiff'], heic: ['heic', 'heif'], heif: ['heic', 'heif'], aiff: ['aif', 'aiff'], aif: ['aif', 'aiff'], mpeg: ['mpg', 'mpeg'], mpg: ['mpg', 'mpeg'] };
const GENERIC: Record<string, readonly string[]> = { image: IMAGE_EXTENSIONS, picture: IMAGE_EXTENSIONS, video: VIDEO_EXTENSIONS, movie: VIDEO_EXTENSIONS, audio: AUDIO_EXTENSIONS, pdf: ['pdf'] };
export const IMAGE_TYPES = [...IMAGE_EXTENSIONS], VIDEO_TYPES = [...VIDEO_EXTENSIONS], AUDIO_TYPES = [...AUDIO_EXTENSIONS], PDF_TYPES = ['pdf'];
export const ALL_TYPES = [...IMAGE_TYPES, ...VIDEO_TYPES, ...AUDIO_TYPES, ...PDF_TYPES];
/** The type words `--types` lists as its default, as macOS prints `ALL_FORMATS`. */
export const ALL_TYPES_HELP = ['webp', 'avif', 'heic', 'jxl', 'bmp', 'tiff', 'png', 'jpeg', 'gif', 'svg', 'mov', 'mp4', 'webm', 'mkv', 'm2v', 'avi', 'm4v', 'mpg', 'wav', 'aiff', 'mp3', 'flac', 'm4a', 'ogg', 'opus', 'pdf'].join(', ');

/** The extensions a list of type words stands for. Unknown words are a usage error, as an unparsable `UTType` is on macOS. */
export function typeExtensions(words: string[] | undefined, option = '--types'): string[] {
  return [...new Set((words ?? []).flatMap(word => {
    const lower = word.toLowerCase().replace(/^\./, '');
    const extensions = GENERIC[lower] ?? SAME[lower] ?? (ALL_TYPES.includes(lower) ? [lower] : undefined);
    if (!extensions) throw new ValidationError(`The value '${word}' is invalid for '${option} <${option.slice(2)}>'`);
    return extensions;
  }))];
}

/** `types` minus `excluded`, with `fallback` when no `--types` was given. */
export function chosenTypes(types: string[] | undefined, excluded: string[] | undefined, fallback = ALL_TYPES): string[] {
  const chosen = types?.length ? typeExtensions(types) : fallback, without = new Set(typeExtensions(excluded, '--exclude-types'));
  return chosen.filter(ext => !without.has(ext));
}

const extension = (file: string) => path.extname(file).slice(1).toLowerCase();
const isURL = (item: string) => /^(https?|file):\/\//i.test(item);
/** A path as the user typed it, made absolute against the working folder, with `~` meaning the user profile. */
export const localPath = (item: string, cwd: string, home?: string) => path.resolve(cwd, resolveHome(item, home));

/** `getURLsFromFolder`: files of the given types, descending into subfolders when `recursive`, skipping hidden folders, node_modules and .git. */
export async function folderFiles(folder: string, recursive: boolean, types: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !entry.name.startsWith('.') && entry.name !== 'node_modules') files.push(...await folderFiles(full, recursive, types));
    } else if (entry.isFile() && types.includes(extension(entry.name))) files.push(full);
  }
  return files.sort();
}

/** `validateItems`: every file, folder content and URL to send, as URL strings. A missing file is an error unless `skipErrors`. */
export async function validateItems(items: string[], { recursive, skipErrors, types, cwd, home }: { recursive: boolean; skipErrors: boolean; types: readonly string[]; cwd: string; home?: string }): Promise<string[]> {
  const urls: string[] = [], folders: string[] = [];
  for (const item of items) {
    if (isURL(item) && !item.toLowerCase().startsWith('file:')) { urls.push(item); continue; }
    const file = isURL(item) ? fileURLToPath(item) : localPath(item, cwd, home);
    const info = await stat(file).catch(() => undefined);
    if (!info) { if (skipErrors) continue; throw new ValidationError(`File ${file} does not exist`); }
    if (info.isDirectory()) folders.push(file);
    else if (types.includes(extension(file))) urls.push(fileURL(file));
  }
  for (const folder of folders) urls.push(...(await folderFiles(folder, recursive, types)).map(fileURL));
  // A file named twice, or named and inside a folder, is worked on once.
  return [...new Set(urls)];
}

/** `normalizeRelativeOutput`: an output path or template made absolute against the working folder. */
export function normalizeOutput(output: string | undefined, cwd: string, home?: string): string | undefined {
  if (output === undefined) return undefined;
  const expanded = resolveHome(output, home);
  if (path.isAbsolute(expanded) || /^%[PF]/.test(expanded)) return expanded;
  return path.join(cwd, expanded.replace(/^\.[\\/]/, ''));
}

/** `checkOutputIsDir`: several files need a folder (or a template) to go to; the folder is created. */
export async function checkOutputIsDir(output: string | undefined, count: number) {
  if (!output || !/[\\/]/.test(output) || output.includes('%') || count <= 1) return;
  const info = await stat(output).catch(() => undefined);
  if (info && !info.isDirectory()) throw new ValidationError('Output path must be a folder when processing multiple files');
  await mkdir(output, { recursive: true });
}
