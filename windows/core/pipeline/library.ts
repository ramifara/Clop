import path from 'node:path';
import { portablePath } from '../settings/paths';
import type { ClopSettings } from '../settings/schema';
import { resolveHome } from '../template';
import { isReadable, type Stored } from './codec';
import { FILE_TYPES, newPipelineId, referenceTo, type ClopFileType, type Pipeline, type PresetZone } from './model';
import { cleanupPipelineText, parseSteps } from './parser';
import { PIPELINE_SOURCE_KEYS } from './triggers';

// The pipeline library edits `clop pipeline add|delete|attach|detach|preset` make (ClopCLI/main.swift). Each takes the
// current settings and returns the stored values to write plus what to tell the user, so the CLI can apply them through the
// running app (which owns the settings file) or straight to the file when the app is not running.

export interface LibraryEdit {
  values: Partial<ClopSettings>; message: string; notes?: string[];
  /** Settings the edit looked at without writing; the save names them too, so it is refused if one changed in between. */
  read?: (keyof ClopSettings)[];
}
/** How names and sources are highlighted in messages; the CLI colours them as macOS does. */
export interface Paint { name(text: string): string; source(text: string): string }
const PLAIN: Paint = { name: text => text, source: text => text };
export class LibraryError extends Error { override name = 'LibraryError'; }

/** `KNOWN_PIPELINE_STEPS`: the step names the CLI recognises before the full parse. */
export const KNOWN_PIPELINE_STEPS = [
  'optimise', 'downscale', 'lowerBitrate', 'convert', 'crop', 'extractPagesAsImages', 'targetSize', 'stripExif', 'watermark', 'capFps', 'normalize',
  'copy', 'move', 'rename', 'delete', 'if', 'ifNot', 'removeAudio', 'changeSpeed', 'runScript', 'runShortcut', 'copyToClipboard', 'copyLinkForSending', 'fork',
  'shelveWith', 'uploadWith', 'openWith',
];

/** `invalidPipelineSteps`: step names in `text` that are not steps. */
export function invalidPipelineSteps(text: string): string[] {
  return text.split('->').flatMap(part => part.split('\n')).map(step => step.trim()).filter(Boolean).flatMap(step => {
    const name = step.includes('(') ? step.slice(0, step.indexOf('(')).trim() : step;
    return KNOWN_PIPELINE_STEPS.includes(name) ? [] : [name];
  });
}

export const savedPipelines = (settings: Pick<ClopSettings, 'savedPipelines'>) => settings.savedPipelines.filter(isReadable);
const sameName = (a: string | undefined, b: string) => a !== undefined && a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
export const findSaved = (settings: Pick<ClopSettings, 'savedPipelines'>, nameOrId: string, byId = true) => savedPipelines(settings).find(p => sameName(p.name, nameOrId) || (byId && p.id === nameOrId));

/** `resolvePipelineArg`: a saved pipeline by name or id, else inline steps, else the unknown step names. */
export function resolvePipelineArgument(settings: Pick<ClopSettings, 'savedPipelines'>, arg: string): { saved: Pipeline } | { inline: true } | { unknown: string[] } {
  const saved = findSaved(settings, arg);
  if (saved) return { saved };
  const unknown = invalidPipelineSteps(arg);
  return unknown.length ? { unknown } : { inline: true };
}

/** The message for an argument that is neither a saved pipeline nor known steps. */
export function unknownPipelineMessage(settings: Pick<ClopSettings, 'savedPipelines'>, arg: string, unknown: string[], what = 'name') {
  const names = savedPipelines(settings).flatMap(p => p.name ?? []);
  return `'${arg}' is not a saved pipeline ${what} and contains unknown steps: ${unknown.join(', ')}\nKnown steps: ${KNOWN_PIPELINE_STEPS.join(', ')}\nSaved pipelines: ${names.length ? names.join(', ') : 'none'}`;
}

const checkType = (type: string | undefined, option: string): ClopFileType | undefined => {
  if (type !== undefined && !(FILE_TYPES as readonly string[]).includes(type)) throw new LibraryError(option === '--file-type' ? `Invalid file type '${type}': must be image, video, pdf or audio` : `Invalid ${option} '${type}': must be image, video, pdf, or audio`);
  return type as ClopFileType | undefined;
};

/** Inline steps as a stored pipeline: parsed, so a mistake is reported now rather than when it runs, with the text kept as written. */
function inlinePipeline(text: string, flags: { skipOptimisation?: boolean; hideResult?: boolean; fileType?: ClopFileType; name?: string }, home?: string): Pipeline {
  const unknown = invalidPipelineSteps(text);
  if (unknown.length) throw new LibraryError(`Unknown steps: ${unknown.join(', ')}\nKnown steps: ${KNOWN_PIPELINE_STEPS.join(', ')}`);
  return {
    id: newPipelineId(), ...(flags.name !== undefined ? { name: flags.name } : {}), rawText: cleanupPipelineText(text, home),
    steps: parseSteps(text, { home, ...(flags.fileType ? { fileType: flags.fileType } : {}) }),
    skipOptimisation: !!flags.skipOptimisation, hideResult: !!flags.hideResult, ...(flags.fileType ? { fileType: flags.fileType } : {}),
  };
}

/** `pipeline add`. */
export function addPipeline(settings: ClopSettings, { name, steps, fileType, skipOptimisation, hideResult, force }: { name: string; steps: string; fileType?: string; skipOptimisation?: boolean; hideResult?: boolean; force?: boolean }, home?: string, paint = PLAIN): LibraryEdit {
  const type = checkType(fileType, '--file-type');
  const pipeline = inlinePipeline(steps, { name, skipOptimisation, hideResult, fileType: type }, home);
  const list = [...settings.savedPipelines], index = list.findIndex(p => isReadable(p) && sameName(p.name, name));
  if (index >= 0 && !force) throw new LibraryError(`A pipeline named '${name}' already exists, use \`--force\` to replace it`);
  if (index >= 0) list[index] = pipeline; else list.push(pipeline);
  return { values: { savedPipelines: list }, message: `Saved pipeline ${paint.name(name)}: ${steps}` };
}

/** `pipeline delete`. */
export function deletePipeline(settings: ClopSettings, name: string, paint = PLAIN): LibraryEdit {
  const list = settings.savedPipelines.filter(p => !(isReadable(p) && sameName(p.name, name)));
  if (list.length === settings.savedPipelines.length) throw new LibraryError(`No saved pipeline named '${name}'`);
  return { values: { savedPipelines: list }, message: `Deleted pipeline ${paint.name(name)}` };
}

const FIXED_SOURCES = new Set(['clipboard', 'dropZone', 'drop-zone', 'drop zone', 'fileWatcher', 'file-watcher', 'file watcher', 'openWith', 'open-with', 'open with', 'service', 'photos', 'shortcuts', 'cli', 'finder']);
/** `normalizedFolderSource`: a folder source as the portable path folders are keyed by (`~/Downloads`), or undefined for a keyword source. */
export function folderSource(source: string, home?: string): string | undefined {
  if (FIXED_SOURCES.has(source)) return undefined;
  return portablePath(path.resolve(resolveHome(source, home)), home);
}

const DIRS_KEYS = { image: 'imageDirs', video: 'videoDirs', pdf: 'pdfDirs', audio: 'audioDirs' } as const satisfies Record<ClopFileType, keyof ClopSettings>;
const ENABLED_KEYS = { image: 'enableAutomaticImageOptimisations', video: 'enableAutomaticVideoOptimisations', pdf: 'enableAutomaticPDFOptimisations', audio: 'enableAutomaticAudioOptimisations' } as const satisfies Record<ClopFileType, keyof ClopSettings>;

/** A pipeline argument as stored for an attachment or preset zone: a reference to a saved pipeline, or the inline steps. */
function attachedPipeline(settings: ClopSettings, arg: string, flags: { skipOptimisation?: boolean; hideResult?: boolean }, home?: string): { pipeline: Pipeline; label: string } {
  const resolved = resolvePipelineArgument(settings, arg);
  if ('unknown' in resolved) throw new LibraryError(unknownPipelineMessage(settings, arg, resolved.unknown, 'name/id'));
  if ('saved' in resolved) return { pipeline: referenceTo(resolved.saved), label: resolved.saved.name ?? resolved.saved.id };
  return { pipeline: inlinePipeline(arg, flags, home), label: arg };
}

/** `pipeline attach`: a folder source also gets watched, and automatic processing for the type switched on. */
export function attachPipeline(settings: ClopSettings, { pipeline: arg, source, type, skipOptimisation, hideResult }: { pipeline: string; source: string; type: string; skipOptimisation?: boolean; hideResult?: boolean }, home?: string, paint = PLAIN): LibraryEdit {
  const fileType = checkType(type, '--type')!;
  const { pipeline, label } = attachedPipeline(settings, arg, { skipOptimisation, hideResult }, home);
  const folder = folderSource(source, home), stored = folder ?? source, key = PIPELINE_SOURCE_KEYS[fileType];
  const values: Partial<ClopSettings> = { [key]: { ...settings[key], [stored]: [...(settings[key][stored] ?? []), pipeline] } };
  const notes: string[] = [];
  if (folder) {
    const dirs = settings[DIRS_KEYS[fileType]];
    if (!dirs.some(dir => portablePath(path.resolve(resolveHome(dir, home)), home) === folder)) { values[DIRS_KEYS[fileType]] = [...dirs, folder]; notes.push('now watching this folder'); }
    if (!settings[ENABLED_KEYS[fileType]]) { values[ENABLED_KEYS[fileType]] = true; notes.push(`enabled automatic ${fileType} processing`); }
  }
  return { values, message: `Attached to ${paint.source(stored)} (${paint.name(fileType)}): ${label}`, notes, read: ['savedPipelines', ...(folder ? [DIRS_KEYS[fileType], ENABLED_KEYS[fileType]] : [])] };
}

/** `pipeline detach`: removing a folder's last pipeline also stops watching it for that type. */
export function detachPipeline(settings: ClopSettings, { source, type, index, all }: { source: string; type: string; index?: number; all?: boolean }, home?: string, paint = PLAIN): LibraryEdit {
  const fileType = checkType(type, '--type')!;
  if (index !== undefined && all) throw new LibraryError('Pass either --index or --all, not both');
  if (index === undefined && !all) throw new LibraryError('Pass either --index <n> or --all');
  const key = PIPELINE_SOURCE_KEYS[fileType], attached = { ...settings[key] }, folder = folderSource(source, home);
  const stored = folder && attached[folder] ? folder : attached[source] ? source : folder ?? source;
  const list = [...(attached[stored] ?? [])];
  if (!list.length) throw new LibraryError(`No pipelines attached to '${source}' for ${fileType}`);
  let message: string;
  if (all) { delete attached[stored]; message = `Removed ${list.length} pipeline${list.length === 1 ? '' : 's'} from ${paint.source(stored)} (${paint.name(fileType)})`; }
  else {
    if (index! < 0 || index! >= list.length) throw new LibraryError(`Index ${index} is out of range (0..${list.length - 1})`);
    list.splice(index!, 1);
    if (list.length) attached[stored] = list; else delete attached[stored];
    message = `Removed pipeline at index ${index} from ${paint.source(stored)} (${paint.name(fileType)})`;
  }
  const values: Partial<ClopSettings> = { [key]: attached }, notes: string[] = [];
  const dirs = settings[DIRS_KEYS[fileType]];
  if (folder && !attached[stored] && dirs.some(dir => dir === folder || dir === stored)) {
    values[DIRS_KEYS[fileType]] = dirs.filter(dir => dir !== folder && dir !== stored);
    notes.push(`Stopped watching this folder for ${fileType}`);
  }
  return { values, message, notes, ...(folder ? { read: [DIRS_KEYS[fileType]] } : {}) };
}

const zoneId = (zone: Stored<PresetZone>) => isReadable(zone) ? zone.id : (typeof zone.raw === 'string' ? (() => { try { return JSON.parse(zone.raw).id; } catch { return undefined; } })() : (zone.raw as { id?: unknown })?.id);

/** `pipeline preset add`: the zone id is `<name>-<type or all>`. The icon is a name the drop zone maps to a glyph. */
export function addPresetZone(settings: ClopSettings, { name, pipeline: arg, type, icon = 'wand.and.stars', skipOptimisation, hideResult, force }: { name: string; pipeline: string; type?: string; icon?: string; skipOptimisation?: boolean; hideResult?: boolean; force?: boolean }, home?: string, paint = PLAIN): LibraryEdit {
  const fileType = checkType(type, '--type'), id = `${name}-${fileType ?? 'all'}`;
  const { pipeline } = attachedPipeline(settings, arg, { skipOptimisation, hideResult }, home);
  const zone: PresetZone = { id, icon, name, ...(fileType ? { type: fileType } : {}), pipeline };
  const zones = [...settings.presetZones], index = zones.findIndex(z => zoneId(z) === id);
  if (index >= 0 && !force) throw new LibraryError(`A preset zone with id '${id}' already exists. Use --force to replace it.`);
  if (index >= 0) zones[index] = zone; else zones.push(zone);
  return { values: { presetZones: zones }, message: `${index >= 0 ? 'Replaced' : 'Added'} preset zone ${paint.name(name)} (type: ${fileType ?? 'all'})`, read: ['savedPipelines'] };
}

/** `pipeline preset remove`. */
export function removePresetZone(settings: ClopSettings, { name, type }: { name: string; type?: string }, paint = PLAIN): LibraryEdit {
  const fileType = checkType(type, '--type'), id = `${name}-${fileType ?? 'all'}`;
  const zones = settings.presetZones.filter(zone => zoneId(zone) !== id);
  if (zones.length === settings.presetZones.length) throw new LibraryError(`No preset zone with id '${id}' found. Use \`clop pipeline list\` (or check preset zone names) to verify.`);
  return { values: { presetZones: zones }, message: `Removed preset zone ${paint.name(name)} (type: ${fileType ?? 'all'})` };
}
