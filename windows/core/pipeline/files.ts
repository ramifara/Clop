import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { copyTo, exists, moveTo, samePath } from '../fileops';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../media/detect';
import { executePlacement, placedExtension, type FileBehaviour } from '../placement';
import type { RunState } from './run-state';

// Where step results go (`applyLocation` in Clop/Pipeline.swift) and the file steps copy, move, rename and delete
// (PipelineExecution.swift). Every replacement goes through core/placement, so an original replaced in place, or a
// file a result lands on, is kept in the work directory's backups first, and every placed result is marked optimised.

const SEPARATOR = process.platform === 'win32' ? /[\\/]/ : /\//;
const endsInSeparator = (text: string) => SEPARATOR.test(text.at(-1) ?? '');
const extension = (file: string) => path.extname(file).slice(1);
const isDirectory = (target: string) => stat(target).then(info => info.isDirectory(), () => false);

/** Extensions that count as a file type when a template already ends in one (macOS asks UTType; Windows has no such registry to ask headless). */
const KNOWN_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, 'pdf', 'jpe', 'ico', 'psd', 'dng', 'raw', 'cr2', 'nef', 'arw', 'wmv', 'flv', '3gp', 'mts', 'm2ts', 'wma', 'm4b',
  'txt', 'md', 'rtf', 'csv', 'json', 'xml', 'html', 'htm', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', '7z', 'rar', 'tar', 'gz',
]);

/**
 * `hasFileExtension`: whether a name a template produced already ends in an extension, either the file's own or a known
 * file type's. Any dot used to count on macOS, so `Screenshot 2026-10-01 at 10.32.11` was saved with no extension.
 */
export function hasFileExtension(name: string, own: (string | undefined)[]): boolean {
  const ext = extension(name).toLowerCase();
  return !!ext && (own.some(candidate => candidate?.toLowerCase() === ext) || KNOWN_EXTENSIONS.has(ext));
}

async function place(run: RunState, behaviour: FileBehaviour, produced: string, original: string, dest: string) {
  return (await executePlacement(run.opts.env, { behaviour, dest }, produced, original)).path;
}

/**
 * `applyLocation`: puts a step's result where its `location` says, relative to `original` (the step's input).
 * - `inPlace` replaces the original, under the result's name: a conversion leaves no file under the old extension.
 * - `sameFolder` copies the result next to the original. A result named like the original replaces it, as on macOS, but backed up.
 * - `temporaryFolder` leaves it in the run's temporary folder.
 * - anything else is a path template: a bare name lands next to the original, a trailing separator or an existing folder
 *   means "into this folder", and the result's extension is added when the template has none. An agent's run refuses a
 *   template that names a file that exists, unless the user's own placement settings chose it.
 */
export async function applyLocation(run: RunState, location: string, result: string, original: string, fromSettings = false): Promise<string> {
  const unchanged = samePath(result, original);
  // A result in the original's format keeps the original's spelling of the extension (`photo.jpg`, not the encoder's `photo.jpeg`).
  const ownExtension = placedExtension(result, original), name = path.parse(result).name + ownExtension;
  switch (location) {
    case 'inPlace':
      if (unchanged) { await run.mark(original); return original; }
      return place(run, 'inPlace', result, original, path.join(path.dirname(original), name));
    case 'sameFolder': {
      const dest = path.join(path.dirname(original), name);
      if (samePath(dest, result)) return result;
      return place(run, samePath(dest, original) ? 'inPlace' : 'sameFolder', result, original, dest);
    }
    case 'temporaryFolder':
      if (!unchanged) await run.mark(result);
      return result;
  }
  const resolved = run.resolve(location);
  if (!resolved) return result;
  run.expanded(resolved);
  const ext = ownExtension.slice(1);
  let dest: string;
  if (!SEPARATOR.test(resolved)) dest = path.join(path.dirname(original), hasFileExtension(resolved, [ext]) ? resolved : `${resolved}.${ext}`);
  else {
    const absolute = path.resolve(path.dirname(original), resolved);
    run.local(absolute);
    dest = endsInSeparator(resolved) || await isDirectory(absolute) ? path.join(absolute, name) : absolute;
  }
  if (!hasFileExtension(path.basename(dest), [extension(result), extension(original)]) && ext) dest = `${dest}.${ext}`;
  run.local(dest);
  if (samePath(dest, result)) return result;
  if (run.opts.refuseExisting && !fromSettings && ![original, run.original].some(file => samePath(dest, file)) && await exists(dest)) {
    throw new Error(`${dest} already exists, and this request may not replace a file that is already there: ask for an output path that doesn't exist yet.`);
  }
  await mkdir(path.dirname(dest), { recursive: true });
  return place(run, samePath(dest, original) ? 'inPlace' : 'specificFolder', result, original, dest);
}

/** Keeps a different file that already sits at `dest` in the backups before something replaces it; an agent's run is refused instead. */
async function keepCollision(run: RunState, dest: string) {
  if (samePath(dest, run.current) || !await exists(dest)) return;
  if (run.opts.refuseExisting && !samePath(dest, run.original)) throw new Error(`${dest} already exists, and this request may not replace a file that is already there: ask for an output path that doesn't exist yet.`);
  await run.opts.env.workdir.backup(dest, { force: true });
}

/**
 * `resolveFileDestination`: a copy or move target. A relative one lands next to the current file; a trailing separator
 * or an existing folder means "into this folder" under the file's own name; a name without an extension gets the file's.
 */
async function fileDestination(run: RunState, to: string): Promise<string> {
  const named = run.resolve(to), resolved = path.resolve(path.dirname(run.current), named);
  run.expanded(named);
  run.local(resolved);
  if (endsInSeparator(to) || endsInSeparator(named) || await isDirectory(resolved)) {
    await mkdir(resolved, { recursive: true });
    return path.join(resolved, path.basename(run.current));
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  const ext = extension(run.current);
  return !hasFileExtension(path.basename(resolved), [ext]) && ext ? `${resolved}.${ext}` : resolved;
}

/** `copy(to:)`: the copy becomes the file later steps work on. */
export async function copyStep(run: RunState, to: string) {
  const dest = await fileDestination(run, to);
  await keepCollision(run, dest);
  run.current = await copyTo(run.current, dest);
  // Marked, so a watcher over the folder it lands in does not take the copy for a new file and copy it again.
  await run.mark(run.current);
}

/** `move(to:)`: marked like a copy, so a watcher over the folder it lands in does not take it for a new file. */
export async function moveStep(run: RunState, to: string) {
  const dest = await fileDestination(run, to);
  await keepCollision(run, dest);
  run.current = await moveTo(run.current, dest);
  await run.mark(run.current);
}

/** `rename(to:)`: a new name in the same folder, with the file's extension when the template gives none. */
export async function renameStep(run: RunState, to: string) {
  let name = run.resolve(to);
  const last = name.split(SEPARATOR).at(-1) ?? name, ext = extension(run.current);
  if (!hasFileExtension(last, [ext]) && ext) name += `.${ext}`;
  const dest = path.join(path.dirname(run.current), name);
  run.expanded(name);
  run.local(dest);
  await keepCollision(run, dest);
  run.current = await moveTo(run.current, dest);
}

/** `delete(path:)`: moves a path to the Recycle Bin. `sourceFile`, the default, is the file the pipeline started with. */
export async function deleteStep(run: RunState, target: string) {
  const named = target === 'sourceFile' ? run.original : run.resolve(target).trim();
  if (!named) return;
  const resolved = path.resolve(path.dirname(run.current), named);
  run.expanded(named);
  run.local(resolved);
  const info = await stat(resolved).catch(() => undefined);
  if (info) await run.opts.effects.trash(resolved, info.isDirectory() ? 'folder' : 'file');
}
