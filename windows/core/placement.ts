import { access, constants, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { copyTo, exists, moveTo, samePath } from './fileops';
import { requireLocalDrive } from './local-path';
import { defaultMarker, type OptimisedMarker } from './marker';
import type { ClopSettings } from './settings/schema';
import { expandPathTemplate, expandTemplate, isAbsoluteTemplate, nameMatchesTemplate, resolveHome, type Counter } from './template';
import type { Workdir } from './workdir';

// Port of Clop/FilePlacement.swift. Where a produced file goes relative to the file it came from.
// macOS clones files on APFS; here every copy is a plain copy.

export type FileBehaviour = 'temporary' | 'inPlace' | 'sameFolder' | 'specificFolder';
export type FileType = 'image' | 'video' | 'audio' | 'pdf';
export type OutputKind = 'optimised' | 'autoConvert' | 'manualConvert';
/** A per-request override (`PlacementOverride` in Shared.swift). */
export interface PlacementOverride { optimised?: FileBehaviour; autoConvert?: FileBehaviour; manualConvert?: FileBehaviour; sameFolderTemplate?: string; specificFolderTemplate?: string;
  /** A folder the specific-folder template is relative to. Only the template is expanded; the folder is used as it is, whatever its name. */
  specificFolderRoot?: string }
export interface PlacementEnv {
  settings: ClopSettings;
  workdir: Workdir;
  /** The number behind `%i`. Write the new value back to `lastAutoIncrementingNumber`. */
  counter: Counter;
  /** Records placed files as optimised. Defaults to the app-wide cache. */
  marker?: OptimisedMarker;
  home?: string;
  platform?: NodeJS.Platform;
  /** The request comes from an agent: every destination, once its template is expanded, must be on a local drive. */
  agent?: boolean;
}
export interface PlacementPlan {
  behaviour: FileBehaviour;
  /** Undefined means leave `produced` where it is and the original untouched. */
  dest?: string;
}
/** `backup` holds the replaced original; `replaced` holds an unrelated file that already sat at the destination. */
export interface PlacedOutput { path: string; backup?: string; originalRemoved: boolean; replaced?: string }

// Templates are stored portable (`~/Pictures/%f`), so a specific-folder template is expanded before anything treats it as a real path.
const DEFAULT_SAME_FOLDER = '%f-optimised', DEFAULT_SPECIFIC_FOLDER = '%P/optimised/%f';
/** What an empty template falls back to when a file is named, so a preview can say the same (`templateOf`). */
export const emptyTemplate = (folder: 'same' | 'specific', converted: boolean) => folder === 'same' ? converted ? '%f' : DEFAULT_SAME_FOLDER : DEFAULT_SPECIFIC_FOLDER;
const SUFFIX: Record<FileType, string> = { image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF' };
// PDFs have no conversion settings, so conversions follow the optimise ones.
const hasConversionKeys = (type: FileType) => type !== 'pdf';

/** Port of `effectiveBehaviour`: the override if there is one, else the setting for this type and kind. */
export function effectiveBehaviour(env: PlacementEnv, type: FileType, kind: OutputKind, overrides?: PlacementOverride): FileBehaviour {
  const override = overrides?.[kind];
  if (override) return override;
  const s = env.settings as unknown as Record<string, FileBehaviour>, suffix = SUFFIX[type];
  if (kind === 'optimised' || !hasConversionKeys(type)) return s[`optimised${suffix}Behaviour`];
  return s[kind === 'autoConvert' ? `converted${suffix}Behaviour` : `manualConverted${suffix}Behaviour`];
}


function templateOf(env: PlacementEnv, type: FileType, kind: OutputKind, folder: 'same' | 'specific', overrides?: PlacementOverride): string {
  const own = folder === 'same' ? overrides?.sameFolderTemplate : overrides?.specificFolderTemplate;
  if (own !== undefined) return own;
  const s = env.settings as unknown as Record<string, string>, suffix = SUFFIX[type], word = folder === 'same' ? 'SameFolder' : 'SpecificFolder';
  const stored = kind === 'optimised' ? s[`${folder === 'same' ? 'sameFolder' : 'specificFolder'}NameTemplate${suffix}`]
    : hasConversionKeys(type) ? s[`converted${word}NameTemplate${suffix}`] : undefined;
  // Audio's templates are empty by default; an empty template names nothing.
  const template = stored || emptyTemplate(folder, kind !== 'optimised');
  return folder === 'same' ? template : resolveHome(template, env.home, env.platform);
}

const platformOf = (env: PlacementEnv) => env.platform ?? process.platform;
const pathApi = (env: PlacementEnv) => (env.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
const context = (env: PlacementEnv, file: string) => ({ path: file, counter: env.counter, home: env.home, platform: env.platform });
/** Refuses an agent's destination that expansion turned into a network share or a device, or that is in Clop's recovery folders, before anything looks at it. */
const checkedDestination = (env: PlacementEnv, dest: string) => { requireLocalDrive(env.agent, dest, platformOf(env)); env.workdir.keepAgentOut(env.agent, dest); return dest; };
const stemOf = (file: string, env: PlacementEnv) => pathApi(env).parse(file).name;
const withoutExtension = (file: string, env: PlacementEnv) => { const p = pathApi(env), { dir, name } = p.parse(file); return p.join(dir, name); };

/**
 * The specific-folder destination when the folder is chosen apart from the template: only the template is expanded, so a
 * folder named `O'Brien` or `100%d` keeps its name, and the result must still land inside it.
 */
async function rootedDestination(env: PlacementEnv, template: string, root: string, original: string): Promise<string> {
  const p = pathApi(env), platform = platformOf(env), inside = (file: string) => { const relative = p.relative(root, file); return relative !== '' && relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative) ? relative : undefined; };
  // Already at the templated place under the folder: leave it, so a template is never stacked.
  const held = inside(original);
  if (held && nameMatchesTemplate(withoutExtension(held, env), template, { platform, singleFileName: true })) return original;
  const dest = expandPathTemplate(template, { ...context(env, original), relativeTo: root });
  checkedDestination(env, dest);
  if (!inside(dest)) throw new Error(`The name template ${template} puts ${stemOf(original, env)} outside the chosen folder.`);
  await mkdir(p.dirname(dest), { recursive: true });
  return dest;
}

/**
 * Port of `destinationPath`: where `original`'s result goes, or undefined for `temporary`. Idempotent:
 * a path that already sits at the templated location is returned unchanged, so a template is never
 * stacked (`img-optimised.png` -> `img-optimised-optimised.png`). Creates the folder of a `specificFolder` result.
 */
export async function destinationPath(env: PlacementEnv, type: FileType, kind: OutputKind, original: string, overrides?: PlacementOverride): Promise<string | undefined> {
  const behaviour = effectiveBehaviour(env, type, kind, overrides), platform = env.platform ?? process.platform;
  switch (behaviour) {
    case 'temporary': return undefined;
    case 'inPlace': return original;
    case 'sameFolder': {
      const template = templateOf(env, type, kind, 'same', overrides);
      if (nameMatchesTemplate(stemOf(original, env), template, { platform })) return original;
      return checkedDestination(env, pathApi(env).join(pathApi(env).dirname(original), expandTemplate(template, context(env, original))));
    }
    case 'specificFolder': {
      const template = templateOf(env, type, kind, 'specific', overrides), root = overrides?.specificFolderRoot;
      if (root !== undefined) return rootedDestination(env, template, root, original);
      const absolute = isAbsoluteTemplate(template, env);
      if (nameMatchesTemplate(withoutExtension(original, env), template, { allowPathPrefix: !absolute, platform })) return original;
      const dest = checkedDestination(env, expandPathTemplate(template, context(env, original)));
      await mkdir(pathApi(env).dirname(dest), { recursive: true });
      return dest;
    }
  }
}

/** Extensions that name one format, so `photo.jpg` optimised as JPEG stays `photo.jpg`. */
const FORMAT_ALIASES: Record<string, string> = { jpg: 'jpeg', jpe: 'jpeg', tif: 'tiff', heif: 'heic', aif: 'aiff', htm: 'html', mpg: 'mpeg', qt: 'mov' };
const formatOf = (ext: string) => { const bare = ext.replace(/^\./, '').toLowerCase(); return FORMAT_ALIASES[bare] ?? bare; };
const extensionOf = (file: string) => /\.[^.\\/]*$/.exec(file)?.[0] ?? '';
/**
 * The extension a result placed for `original` takes: the original's own spelling (`.jpg`, `.JPG`, `.tif`) when the format did
 * not change, the produced file's when it did (a conversion), and the original's when the produced file has none.
 */
export function placedExtension(produced: string, original: string): string {
  const own = extensionOf(original), made = extensionOf(produced);
  return !made ? own : own && formatOf(own) === formatOf(made) ? own : made;
}

/**
 * Port of `planPlacement`: decides the behaviour and destination, including the `%i` counter, with no
 * heavy I/O. A conversion lands under the produced file's extension (`.webp`); a result in the original's format keeps
 * the original's spelling of it (`.jpg`, not the encoder's `.jpeg`).
 * Throws when the destination folder is not writable, before anything is encoded.
 */
export async function planPlacement(env: PlacementEnv, args: { produced: string; original: string; type: FileType; kind?: OutputKind; overrides?: PlacementOverride }): Promise<PlacementPlan> {
  const { produced, original, type, kind = 'optimised', overrides } = args;
  const behaviour = effectiveBehaviour(env, type, kind, overrides);
  if (behaviour === 'temporary') return { behaviour };
  let dest = await destinationPath(env, type, kind, original, overrides);
  if (!dest) return { behaviour };
  const p = pathApi(env), extension = placedExtension(produced, original);
  if (p.extname(dest).toLowerCase() !== extension.toLowerCase()) dest = p.join(p.dirname(dest), p.parse(dest).name + extension);
  checkedDestination(env, dest);
  // Replacing a file needs write access to the folder holding it, not to the file.
  const folder = p.dirname(dest);
  await access(folder, constants.W_OK).catch(() => { throw new Error(`Clop cannot write to ${folder}. Choose a folder you can write to.`); });
  return { behaviour, dest };
}

/** Placements under way in this process. Quitting or updating waits for them: one may have moved an original aside. */
const inFlight = new Set<Promise<unknown>>();
/** Whether a placement is under way. */
export const placing = () => inFlight.size > 0;
/** Resolves once every placement under way now, and any started meanwhile, has finished, whether or not it worked. */
export async function placementsSettled(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/**
 * Port of `executePlacement`: the file I/O. For `inPlace` the original goes into `workdir.backups` first (restore it
 * with `workdir.restore`), then `produced` is copied to the destination. The copy is atomic, so an interrupted placement never
 * leaves a half-written file. A result that takes the original's own path is copied into the backups and renamed over the
 * original, so that path is never empty (and a failed placement leaves the original as it was); a result under another name
 * moves the original away, as a conversion leaves no file under the old name. The placed file is marked optimised.
 */
export function executePlacement(env: PlacementEnv, plan: PlacementPlan, produced: string, original: string): Promise<PlacedOutput> {
  const work = place(env, plan, produced, original);
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work)).catch(() => {});
  return work;
}

/**
 * While an original is away from its path, a note in the working directory names it and its backup, so a start after a crash
 * or a forced shutdown puts it back (`Workdir.repair`).
 */
async function place(env: PlacementEnv, plan: PlacementPlan, produced: string, original: string): Promise<PlacedOutput> {
  if (!plan.dest) return { path: produced, originalRemoved: false };
  const { dest } = plan, { workdir } = env;
  checkedDestination(env, dest);
  let backup: string | undefined, originalRemoved = false, moved = false, replaced: string | undefined, away: (() => Promise<void>) | undefined;
  // A different file already at the destination (a template collision, or `shot.webp` beside `shot.png`) would be lost to the copy, so keep it first.
  const same = (a: string, b: string) => samePath(a, b, platformOf(env));
  if (!same(dest, original) && !same(dest, produced) && await exists(dest)) {
    replaced = await workdir.backup(dest, { force: true }).catch(error => { throw new Error(`Could not back up ${dest} before replacing it: ${error instanceof Error ? error.message : error}`); });
  }
  // A template that names the original itself (`img-optimised.png` already carries it) replaces the file just as `inPlace` does. macOS has
  // copied the input into its backups before it optimises; here this is the only copy taken, so it is kept in both cases.
  if ((plan.behaviour === 'inPlace' || same(dest, original)) && await exists(original)) {
    if (same(original, produced)) {
      // The optimiser rewrote the original where it stood, so there is nothing to move. Report the copy taken before it ran.
      backup = await workdir.latestBackup(original);
    } else {
      // Overwriting without a backup would lose the only copy, so a failed backup fails the placement.
      moved = !same(dest, original);
      if (moved) away = await workdir.journal(original, await workdir.backupPath(original));
      backup = await workdir.backup(original, { move: moved, force: true }).catch(async error => { await away?.(); throw new Error(`Could not back up ${original} before replacing it: ${error instanceof Error ? error.message : error}`); });
      originalRemoved = backup !== undefined;
    }
  }
  try {
    try { await copyTo(produced, dest); } catch (error) {
      // Windows will not rename over a read-only file or one that is held open; then the original moves out of the way, as it always did.
      if (moved || !backup || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      away = await workdir.journal(original, backup);
      await moveTo(original, backup);
      moved = true;
      await copyTo(produced, dest);
    }
  } catch (error) {
    // A note stays when the original could not be put back, so the next start tries again.
    if (moved && backup && !await moveTo(backup, original).then(() => true, () => false)) away = undefined;
    throw error;
  } finally { await away?.(); }
  await (env.marker ?? defaultMarker()).markOptimised(dest).catch(() => {});
  return { path: dest, backup, originalRemoved, replaced };
}

/** Port of `placeOutput`. */
export async function placeOutput(env: PlacementEnv, args: Parameters<typeof planPlacement>[1]): Promise<PlacedOutput> {
  return executePlacement(env, await planPlacement(env, args), args.produced, args.original);
}

/**
 * Port of `isTemplatedCopy`: whether `file` is a copy Clop made at the templated destination, so nothing
 * but Clop points at it. True only for `sameFolder` and `specificFolder` with a template that renames the file.
 */
export function isTemplatedCopy(env: PlacementEnv, type: FileType, file: string, kind: OutputKind = 'optimised', overrides?: PlacementOverride): boolean {
  const behaviour = effectiveBehaviour(env, type, kind, overrides), platform = env.platform ?? process.platform;
  if (behaviour === 'sameFolder') {
    const template = templateOf(env, type, kind, 'same', overrides);
    return !!template && template !== '%f' && nameMatchesTemplate(stemOf(file, env), template, { platform });
  }
  if (behaviour === 'specificFolder') {
    const template = templateOf(env, type, kind, 'specific', overrides);
    return !!template && nameMatchesTemplate(withoutExtension(file, env), template, { allowPathPrefix: !isAbsoluteTemplate(template, env), platform });
  }
  return false;
}
