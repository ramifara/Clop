import { access, constants, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { copyTo, exists, moveTo, samePath } from './fileops';
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
export interface PlacementOverride { optimised?: FileBehaviour; autoConvert?: FileBehaviour; manualConvert?: FileBehaviour; sameFolderTemplate?: string; specificFolderTemplate?: string }
export interface PlacementEnv {
  settings: ClopSettings;
  workdir: Workdir;
  /** The number behind `%i`. Write the new value back to `lastAutoIncrementingNumber`. */
  counter: Counter;
  /** Records placed files as optimised. Defaults to the app-wide cache. */
  marker?: OptimisedMarker;
  home?: string;
  platform?: NodeJS.Platform;
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
  const template = stored || (folder === 'same' ? kind === 'optimised' ? DEFAULT_SAME_FOLDER : '%f' : DEFAULT_SPECIFIC_FOLDER);
  return folder === 'same' ? template : resolveHome(template, env.home, env.platform);
}

const platformOf = (env: PlacementEnv) => env.platform ?? process.platform;
const pathApi = (env: PlacementEnv) => (env.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
const context = (env: PlacementEnv, file: string) => ({ path: file, counter: env.counter, home: env.home, platform: env.platform });
const stemOf = (file: string, env: PlacementEnv) => pathApi(env).parse(file).name;
const withoutExtension = (file: string, env: PlacementEnv) => { const p = pathApi(env), { dir, name } = p.parse(file); return p.join(dir, name); };

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
      return pathApi(env).join(pathApi(env).dirname(original), expandTemplate(template, context(env, original)));
    }
    case 'specificFolder': {
      const template = templateOf(env, type, kind, 'specific', overrides);
      const absolute = isAbsoluteTemplate(template, env);
      if (nameMatchesTemplate(withoutExtension(original, env), template, { allowPathPrefix: !absolute, platform })) return original;
      const dest = expandPathTemplate(template, context(env, original));
      await mkdir(pathApi(env).dirname(dest), { recursive: true });
      return dest;
    }
  }
}

/**
 * Port of `planPlacement`: decides the behaviour and destination, including the `%i` counter, with no
 * heavy I/O. The result carries the produced file's extension, so a conversion lands as e.g. `.webp`.
 * Throws when the destination folder is not writable, before anything is encoded.
 */
export async function planPlacement(env: PlacementEnv, args: { produced: string; original: string; type: FileType; kind?: OutputKind; overrides?: PlacementOverride }): Promise<PlacementPlan> {
  const { produced, original, type, kind = 'optimised', overrides } = args;
  const behaviour = effectiveBehaviour(env, type, kind, overrides);
  if (behaviour === 'temporary') return { behaviour };
  let dest = await destinationPath(env, type, kind, original, overrides);
  if (!dest) return { behaviour };
  const p = pathApi(env), extension = p.extname(produced) || p.extname(original);
  if (p.extname(dest).toLowerCase() !== extension.toLowerCase()) dest = p.join(p.dirname(dest), p.parse(dest).name + extension);
  // Replacing a file needs write access to the folder holding it, not to the file.
  const folder = p.dirname(dest);
  await access(folder, constants.W_OK).catch(() => { throw new Error(`Clop cannot write to ${folder}. Choose a folder you can write to.`); });
  return { behaviour, dest };
}

/**
 * Port of `executePlacement`: the file I/O. For `inPlace` the original moves into `workdir.backups`
 * first (restore it with `workdir.restore`), then `produced` is copied to the destination. The copy is
 * atomic, so an interrupted placement never leaves a half-written file. The placed file is marked optimised.
 */
export async function executePlacement(env: PlacementEnv, plan: PlacementPlan, produced: string, original: string): Promise<PlacedOutput> {
  if (!plan.dest) return { path: produced, originalRemoved: false };
  const { dest } = plan, { workdir } = env;
  let backup: string | undefined, originalRemoved = false, replaced: string | undefined;
  // A different file already at the destination (a template collision, or `shot.webp` beside `shot.png`) would be lost to the copy, so keep it first.
  const same = (a: string, b: string) => samePath(a, b, platformOf(env));
  if (!same(dest, original) && !same(dest, produced) && await exists(dest)) {
    replaced = await workdir.backup(dest, { force: true }).catch(error => { throw new Error(`Could not back up ${dest} before replacing it: ${error instanceof Error ? error.message : error}`); });
  }
  if (plan.behaviour === 'inPlace' && await exists(original)) {
    if (same(original, produced)) {
      // The optimiser rewrote the original where it stood, so there is nothing to move. Report the copy taken before it ran.
      backup = await workdir.latestBackup(original);
    } else {
      // Overwriting without a backup would lose the only copy, so a failed backup fails the placement.
      backup = await workdir.backup(original, { move: true, force: true }).catch(error => { throw new Error(`Could not back up ${original} before replacing it: ${error instanceof Error ? error.message : error}`); });
      originalRemoved = backup !== undefined;
    }
  }
  try { await copyTo(produced, dest); } catch (error) {
    if (originalRemoved && backup) await moveTo(backup, original).catch(() => {});
    throw error;
  }
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
