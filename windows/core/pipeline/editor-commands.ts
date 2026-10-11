import { Unreadable, decodePipeline, isReadable, storedId, type Stored } from './codec';
import { DIR_KEYS, FIXED_SOURCES, entryKeys, revisionOf, sourceEntry, type EditorContext, type EditorSettings } from './editor-state';
import { parseJsoncSteps, stripJsonc } from './jsonc';
import { FILE_TYPES, newPipelineId, referenceTo, type ClopFileType, type Pipeline, type PresetZone } from './model';
import { canFormat, cleanupPipelineText, formatSteps, parsePipelineText, type PipelineIssue } from './parser';
import { PIPELINE_SOURCE_KEYS } from './triggers';

// The commands the editor window sends the main process (spec step 22). The renderer never writes pipeline settings: each
// command is checked here, malformed ones are refused with an Error, and a pipeline the user wrote that does not parse comes
// back as `issues` at their positions. A command returns the settings keys it changes, ready for `SettingsStore.set`.

export const LIMITS = { library: 500, perSource: 20, zones: 40, text: 20_000, /** A stored entry this version cannot read can be large (a long pipeline from a Mac); its JSON is sent back whole. */ fix: 500_000, name: 80, zoneName: 40, details: 300, id: 100, path: 1000 };
const ICON = /^[\w.-]{1,64}$/;

export type EditorCommand =
  | { type: 'pipeline-save'; id?: string; base?: string; name: string; fileType?: ClopFileType; icon?: string; details?: string; skipOptimisation: boolean; hideResult: boolean; view: 'text' | 'json'; text: string }
  | { type: 'pipeline-fix'; key: string; base: string; json: string }
  | { type: 'pipeline-delete'; key: string; base: string }
  | { type: 'attach'; fileType: ClopFileType; source: string; pipelineId: string }
  | { type: 'detach'; fileType: ClopFileType; source: string; key: string; base: string }
  | { type: 'zone-save'; id?: string; base?: string; name: string; icon: string; fileType?: ClopFileType; pipelineId?: string }
  | { type: 'zone-delete'; key: string; base: string }
  | { type: 'zone-move'; key: string; to: number };
export interface CommandResult {
  /** The settings keys the command changes; empty when it changed nothing. */
  patch: Partial<EditorSettings>;
  /** Problems with what the user wrote. The command did nothing. */
  issues?: PipelineIssue[];
  /** The command did nothing because the entry it names is no longer what the window showed. */
  conflict?: boolean;
  /** The id of the pipeline or zone the command saved. */
  saved?: string;
  /** Attachments and preset zones removed together with a deleted pipeline. */
  removed?: { attachments: number; zones: number };
}

// Malformed arguments are programming errors or an untrusted caller: refuse them whole.
const refuse = (what: string): never => { throw new Error(`The editor sent an invalid ${what}.`); };
const record = (value: unknown, what = 'command') => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : refuse(what);
const text = (value: unknown, what: string, max: number, { empty = false } = {}) => typeof value === 'string' && value.length <= max && (empty || value.trim()) ? value : refuse(what);
const optional = <T>(value: unknown, read: (value: unknown) => T) => value === undefined || value === null ? undefined : read(value);
const flag = (value: unknown, what: string) => typeof value === 'boolean' ? value : refuse(what);
const fileType = (value: unknown) => typeof value === 'string' && (FILE_TYPES as readonly string[]).includes(value) ? value as ClopFileType : refuse('file type');
const idOf = (value: unknown, what = 'id') => text(value, what, LIMITS.id);
/** The revision of the entry the window showed (`revisionOf`), which the command acts on only while it is still stored. */
const revision = (value: unknown) => idOf(value, 'revision');
/** Any text up to the largest size, which a value stored by a newer or other version may reach; `checkLabels` holds new values to the real limits. */
const icon = (value: unknown) => typeof value === 'string' && value.length <= LIMITS.path ? value : refuse('icon');

/** A save of an existing entry (it has an id) names the revision it replaces; a new one has neither. */
function withBase(c: Record<string, unknown>): { id?: string; base?: string } {
  const id = optional(c.id, v => idOf(v));
  return id === undefined ? { id } : { id, base: revision(c.base) };
}

/** The command as typed data, or an Error when anything is missing, the wrong type or too long. */
export function parseCommand(value: unknown): EditorCommand {
  const c = record(value);
  switch (c.type) {
    case 'pipeline-save': return {
      type: 'pipeline-save', ...withBase(c), name: text(c.name, 'name', LIMITS.text).trim(), fileType: optional(c.fileType, fileType), icon: optional(c.icon, icon),
      details: optional(c.details, v => text(v, 'description', LIMITS.text, { empty: true }).trim() || undefined), skipOptimisation: flag(c.skipOptimisation, 'setting'), hideResult: flag(c.hideResult, 'setting'),
      view: c.view === 'text' || c.view === 'json' ? c.view : refuse('view'), text: text(c.text, 'pipeline text', LIMITS.text, { empty: true }),
    };
    case 'pipeline-fix': return { type: 'pipeline-fix', key: idOf(c.key, 'entry'), base: revision(c.base), json: text(c.json, 'pipeline JSON', LIMITS.fix) };
    case 'pipeline-delete': return { type: 'pipeline-delete', key: idOf(c.key, 'entry'), base: revision(c.base) };
    case 'attach': return { type: 'attach', fileType: fileType(c.fileType), source: text(c.source, 'source', LIMITS.path), pipelineId: idOf(c.pipelineId) };
    case 'detach': return { type: 'detach', fileType: fileType(c.fileType), source: text(c.source, 'source', LIMITS.path), key: idOf(c.key, 'entry'), base: revision(c.base) };
    case 'zone-save': return {
      type: 'zone-save', ...withBase(c), name: text(c.name, 'name', LIMITS.text).trim(), icon: icon(c.icon), fileType: optional(c.fileType, fileType), pipelineId: optional(c.pipelineId, v => idOf(v)),
    };
    case 'zone-delete': return { type: 'zone-delete', key: idOf(c.key, 'zone'), base: revision(c.base) };
    case 'zone-move': return { type: 'zone-move', key: idOf(c.key, 'zone'), to: Number.isInteger(c.to) && (c.to as number) >= 0 && (c.to as number) < LIMITS.zones ? c.to as number : refuse('position') };
    default: return refuse('command');
  }
}

/**
 * Holds the name, description and icon of a save to their limits, except a value the entry already stores: a pipeline or zone
 * made by another version or tool may hold a longer name or an icon this window would not accept, and it must stay editable.
 */
function checkLabels(c: { name: string; details?: string; icon?: string }, previous: { name?: string; details?: string; icon?: string } | undefined, nameLimit: number): CommandResult | undefined {
  const kept = (value: string | undefined, before: string | undefined) => value === before;
  if (c.name.length > nameLimit && !kept(c.name, previous?.name?.trim())) return problem(`The name can be at most ${nameLimit} characters; this one has ${c.name.length}.`);
  if (c.details !== undefined && c.details.length > LIMITS.details && !kept(c.details, previous?.details?.trim())) return problem(`The description can be at most ${LIMITS.details} characters; this one has ${c.details.length}.`);
  if (c.icon !== undefined && !ICON.test(c.icon) && !kept(c.icon, previous?.icon)) return problem('An icon name uses only letters, digits, dots, dashes and underscores, and is at most 64 characters.');
  return undefined;
}

const none = (issues: PipelineIssue[]): CommandResult => ({ patch: {}, issues });
const problem = (message: string): CommandResult => none([{ message }]);
const readable = (saved: readonly Stored<Pipeline>[]) => saved.filter(isReadable);
const indexOfKey = (entries: readonly Stored<{ id: string }>[], key: string) => entryKeys(entries).indexOf(key);
const CHANGED = 'It was changed elsewhere since this window showed it.';
const changed = (): CommandResult => ({ patch: {}, issues: [{ message: CHANGED }], conflict: true });
/** The entry still holds what the window showed: same revision. */
const unchanged = (entry: unknown, base: string) => revisionOf(entry) === base;
/** A pipeline for `type` can serve a zone or attachment of that type; one without a type serves any. */
const serves = (pipeline: Pipeline, type: ClopFileType | undefined) => !pipeline.fileType || pipeline.fileType === type;

/** Where `id` is attached or used by a zone. */
function usages(settings: EditorSettings, id: string) {
  const attached = FILE_TYPES.flatMap(kind => Object.entries(settings[PIPELINE_SOURCE_KEYS[kind]] ?? {}).flatMap(([source, entries]) =>
    entries.some(entry => isReadable(entry) && entry.libraryID === id) ? [{ kind, source }] : []));
  const zones = settings.presetZones.filter((zone): zone is PresetZone => isReadable(zone) && zone.pipeline.libraryID === id);
  return { attached, zones };
}

function saveAttachments(settings: EditorSettings, kind: ClopFileType, map: Record<string, Stored<Pipeline>[]>): Partial<EditorSettings> {
  return { [PIPELINE_SOURCE_KEYS[kind]]: Object.fromEntries(Object.entries(map).filter(([, entries]) => entries.length)) };
}

function savePipeline(settings: EditorSettings, c: Extract<EditorCommand, { type: 'pipeline-save' }>, context: EditorContext): CommandResult {
  const index = c.id === undefined ? -1 : indexOfKey(settings.savedPipelines, c.id), existing = settings.savedPipelines[index];
  if (c.id !== undefined && (index < 0 || !isReadable(existing))) return problem('That pipeline is no longer in the library. Save it as a new pipeline.');
  if (c.id !== undefined && !unchanged(existing, c.base!)) return changed();
  if (index < 0 && settings.savedPipelines.length >= LIMITS.library) return problem(`The library holds at most ${LIMITS.library} pipelines.`);
  const previous = existing && isReadable(existing) ? existing : undefined;
  const labels = checkLabels(c, previous, LIMITS.name);
  if (labels) return labels;
  let parsed = c.view === 'text' ? parsePipelineText(c.text, { fileType: c.fileType, home: context.home }) : parseJsoncSteps(c.text, { fileType: c.fileType });
  // Steps the pipeline already has are not held to today's value checks: a stored value Windows rejects must not stop a rename or a flag change.
  if (previous && parsed.issues.length && c.fileType === previous.fileType) {
    const stored = c.view === 'text' ? parsePipelineText(c.text, { fileType: c.fileType, home: context.home, checkValues: false }) : parseJsoncSteps(c.text, { fileType: c.fileType, checkValues: false });
    if (!stored.issues.length && JSON.stringify(stored.steps) === JSON.stringify(previous.steps)) parsed = stored;
  }
  if (parsed.issues.length) return none(parsed.issues);
  if (!parsed.steps.length) return problem('Add at least one step.');
  if (c.id !== undefined) {
    const conflicts = usages(settings, c.id), wrong = [...conflicts.attached.filter(use => c.fileType && use.kind !== c.fileType).map(use => `${use.kind} ${use.source}`),
      ...conflicts.zones.filter(zone => c.fileType && zone.type !== c.fileType).map(zone => `the preset zone ${zone.name}`)];
    if (wrong.length) return problem(`It is attached to ${wrong.join(', ')}. Detach it there before limiting it to ${c.fileType} files.`);
  }
  const rawText = c.view === 'text' ? cleanupPipelineText(c.text, context.home) : parsed.steps.every(canFormat) ? formatSteps(parsed.steps) : undefined;
  const pipeline: Pipeline = { ...previous, id: previous?.id ?? newPipelineId(), steps: parsed.steps, name: c.name, rawText, skipOptimisation: c.skipOptimisation, hideResult: c.hideResult, fileType: c.fileType, icon: c.icon, details: c.details };
  const savedPipelines = [...settings.savedPipelines];
  if (index < 0) savedPipelines.push(pipeline); else savedPipelines[index] = pipeline;
  return { patch: { savedPipelines }, saved: pipeline.id };
}

/** Replaces an entry this version cannot read with the JSON the user fixed, keeping its id so what refers to it still does. */
function fixPipeline(settings: EditorSettings, c: Extract<EditorCommand, { type: 'pipeline-fix' }>): CommandResult {
  const index = indexOfKey(settings.savedPipelines, c.key), entry = settings.savedPipelines[index];
  if (index < 0) return problem('That pipeline is no longer in the library.');
  if (!(entry instanceof Unreadable)) return problem('Only a pipeline that could not be read can be replaced this way.');
  if (!unchanged(entry, c.base)) return changed();
  let pipeline: Pipeline;
  // Comments and trailing commas are allowed, as in the JSON view; blanking them keeps every position.
  try { pipeline = decodePipeline(stripJsonc(c.json)); } catch (error) { return problem((error as Error).message); }
  const original = storedId(entry);
  if (original !== undefined) pipeline = { ...pipeline, id: original };
  if (readable(settings.savedPipelines).some(other => other.id === pipeline.id)) return problem('Another pipeline in the library already has this id.');
  if (!pipeline.name?.trim()) return problem('Give the pipeline a name.');
  const savedPipelines = [...settings.savedPipelines];
  savedPipelines[index] = pipeline;
  return { patch: { savedPipelines }, saved: pipeline.id };
}

function deletePipeline(settings: EditorSettings, c: Extract<EditorCommand, { type: 'pipeline-delete' }>): CommandResult {
  const index = indexOfKey(settings.savedPipelines, c.key);
  if (index < 0) return problem('That pipeline is no longer in the library.');
  if (!unchanged(settings.savedPipelines[index], c.base)) return changed();
  const patch: Partial<EditorSettings> = { savedPipelines: settings.savedPipelines.filter((_, i) => i !== index) };
  const removed = { attachments: 0, zones: 0 };
  if (isReadable(settings.savedPipelines[index])) {
    const id = c.key;
    for (const kind of FILE_TYPES) {
      const map = settings[PIPELINE_SOURCE_KEYS[kind]] ?? {}, next: Record<string, Stored<Pipeline>[]> = {};
      for (const [source, entries] of Object.entries(map)) next[source] = entries.filter(entry => !(isReadable(entry) && entry.libraryID === id));
      const count = Object.values(map).flat().length - Object.values(next).flat().length;
      if (count) { removed.attachments += count; Object.assign(patch, saveAttachments(settings, kind, next)); }
    }
    const zones = settings.presetZones.filter(zone => !(isReadable(zone) && zone.pipeline.libraryID === id));
    removed.zones = settings.presetZones.length - zones.length;
    if (removed.zones) patch.presetZones = zones;
  }
  return { patch, removed };
}

/** The key `source` is stored under, if it is somewhere pipelines can be attached: the clipboard, the drop zone or a watched folder of this type. */
function attachableSource(settings: EditorSettings, kind: ClopFileType, source: string, context: EditorContext) {
  if ((FIXED_SOURCES as readonly string[]).includes(source)) return source;
  return sourceEntry(Object.fromEntries(settings[DIR_KEYS[kind]].map(dir => [dir, true])), source, context)?.key;
}

function attach(settings: EditorSettings, c: Extract<EditorCommand, { type: 'attach' }>, context: EditorContext): CommandResult {
  const target = readable(settings.savedPipelines).find(entry => entry.id === c.pipelineId);
  if (!target) return problem('That pipeline is no longer in the library.');
  if (!serves(target, c.fileType)) return problem(`${target.name ?? 'That pipeline'} works on ${target.fileType} files, not ${c.fileType} files.`);
  const source = attachableSource(settings, c.fileType, c.source, context);
  if (source === undefined) return problem(`${c.source} is not a clipboard, drop zone or watched ${c.fileType} folder.`);
  const map = { ...(settings[PIPELINE_SOURCE_KEYS[c.fileType]] ?? {}) }, found = sourceEntry(map, source, context), key = found?.key ?? source, entries = found?.entries ?? [];
  if (entries.some(entry => isReadable(entry) && (entry.libraryID ?? entry.id) === target.id)) return problem(`${target.name ?? 'That pipeline'} is already attached there.`);
  if (entries.length >= LIMITS.perSource) return problem(`At most ${LIMITS.perSource} pipelines can be attached to one place.`);
  map[key] = [...entries, referenceTo(target)];
  return { patch: saveAttachments(settings, c.fileType, map) };
}

function detach(settings: EditorSettings, c: Extract<EditorCommand, { type: 'detach' }>, context: EditorContext): CommandResult {
  const map = { ...(settings[PIPELINE_SOURCE_KEYS[c.fileType]] ?? {}) }, found = sourceEntry(map, c.source, context);
  const index = found ? indexOfKey(found.entries, c.key) : -1;
  if (!found || index < 0) return problem('That pipeline is no longer attached there.');
  if (!unchanged(found.entries[index], c.base)) return changed();
  map[found.key] = found.entries.filter((_, i) => i !== index);
  return { patch: saveAttachments(settings, c.fileType, map) };
}

function saveZone(settings: EditorSettings, c: Extract<EditorCommand, { type: 'zone-save' }>): CommandResult {
  const index = c.id === undefined ? -1 : indexOfKey(settings.presetZones, c.id), existing = settings.presetZones[index];
  if (c.id !== undefined && (index < 0 || !isReadable(existing))) return problem('That preset zone no longer exists.');
  if (c.id !== undefined && !unchanged(existing, c.base!)) return changed();
  if (index < 0 && settings.presetZones.length >= LIMITS.zones) return problem(`There is room for ${LIMITS.zones} preset zones.`);
  const previous = existing && isReadable(existing) ? existing : undefined;
  const labels = checkLabels(c, previous, LIMITS.zoneName);
  if (labels) return labels;
  let pipeline = previous?.pipeline;
  if (c.pipelineId !== undefined && c.pipelineId !== pipeline?.libraryID) {
    const target = readable(settings.savedPipelines).find(entry => entry.id === c.pipelineId);
    if (!target) return problem('That pipeline is no longer in the library.');
    pipeline = referenceTo(target);
  }
  if (!pipeline) return problem('Choose the pipeline this zone runs.');
  const library = pipeline.libraryID === undefined ? undefined : readable(settings.savedPipelines).find(entry => entry.id === pipeline!.libraryID);
  const used = library ?? pipeline;
  if (!serves(used, c.fileType)) return problem(`${used.name ?? 'That pipeline'} works on ${used.fileType} files, so this zone cannot take ${c.fileType ?? 'any'} files.`);
  const zone: PresetZone = { ...previous, id: previous?.id ?? newPipelineId(), icon: c.icon, name: c.name, type: c.fileType, pipeline };
  const presetZones = [...settings.presetZones];
  if (index < 0) presetZones.push(zone); else presetZones[index] = zone;
  return { patch: { presetZones }, saved: zone.id };
}

function moveZone(settings: EditorSettings, c: Extract<EditorCommand, { type: 'zone-move' }>): CommandResult {
  const index = indexOfKey(settings.presetZones, c.key);
  if (index < 0) return problem('That preset zone no longer exists.');
  const to = Math.min(c.to, settings.presetZones.length - 1), presetZones = [...settings.presetZones];
  const [zone] = presetZones.splice(index, 1);
  presetZones.splice(to, 0, zone);
  return { patch: to === index ? {} : { presetZones } };
}

function deleteZone(settings: EditorSettings, c: Extract<EditorCommand, { type: 'zone-delete' }>): CommandResult {
  const index = indexOfKey(settings.presetZones, c.key);
  if (index < 0) return problem('That preset zone no longer exists.');
  if (!unchanged(settings.presetZones[index], c.base)) return changed();
  return { patch: { presetZones: settings.presetZones.filter((_, i) => i !== index) } };
}

/** Applies a checked command to the settings. Never mutates them; `patch` holds the replaced settings values. */
export function applyCommand(settings: EditorSettings, command: unknown, context: EditorContext = {}): CommandResult {
  const c = parseCommand(command);
  switch (c.type) {
    case 'pipeline-save': return savePipeline(settings, c, context);
    case 'pipeline-fix': return fixPipeline(settings, c);
    case 'pipeline-delete': return deletePipeline(settings, c);
    case 'attach': return attach(settings, c, context);
    case 'detach': return detach(settings, c, context);
    case 'zone-save': return saveZone(settings, c);
    case 'zone-delete': return deleteZone(settings, c);
    case 'zone-move': return moveZone(settings, c);
  }
}
