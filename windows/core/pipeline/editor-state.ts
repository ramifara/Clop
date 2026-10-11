import type { ClopSettings } from '../settings/schema';
import { Unreadable, isReadable, storedId, type Stored } from './codec';
import { isBuiltin, pipelineProblems, resolveRunnable, FILE_TYPES, type ClopFileType, type Pipeline } from './model';
import { canFormat, formatSteps, parsePipelineText } from './parser';
import { stepsToJsonc } from './jsonc';
import { PIPELINE_SOURCE_KEYS, sourceKey } from './triggers';

// What the pipeline editor window shows, built by the main process from the settings: the saved library, what is attached
// to the clipboard, the drop zone and each watched folder, and the preset zones. The renderer only reads these; it changes
// settings by sending the commands in `editor-commands.ts`, which the main process validates again.

export const DIR_KEYS = { image: 'imageDirs', video: 'videoDirs', pdf: 'pdfDirs', audio: 'audioDirs' } as const satisfies Record<ClopFileType, keyof ClopSettings>;
export type EditorSettings = Pick<ClopSettings, 'savedPipelines' | 'presetZones' | (typeof PIPELINE_SOURCE_KEYS)[ClopFileType] | (typeof DIR_KEYS)[ClopFileType]>;
export const EDITOR_SETTING_KEYS = ['savedPipelines', 'presetZones', ...Object.values(PIPELINE_SOURCE_KEYS), ...Object.values(DIR_KEYS)] as const satisfies readonly (keyof ClopSettings)[];
export interface EditorContext { home?: string; platform?: NodeJS.Platform }

/** Sources that are not folders: pipelines attached to them run on copied files and on files dropped on the drop target. */
export const FIXED_SOURCES = ['clipboard', 'dropZone'] as const;

export interface PipelineView {
  readable: true;
  /** The id, which commands name the pipeline by. */
  key: string;
  /** A fingerprint of the stored entry. Commands that change or remove it carry the one the window saw, so a change made elsewhere is noticed. */
  revision: string;
  name: string;
  builtin: boolean;
  fileType?: ClopFileType;
  icon?: string;
  details?: string;
  skipOptimisation: boolean;
  hideResult: boolean;
  /** The pipeline as text: what the user wrote, or its steps written out. Empty when some step has no exact text form. */
  text: string;
  /** The steps as the JSON view shows them. */
  json: string;
  /** Every step has an exact text form, so the text view loses nothing. */
  exact: boolean;
  /** Problems the stored steps have on Windows, such as a value only macOS accepts. */
  problems: string[];
}
/** A saved entry this version cannot read. It is kept as it is; the editor shows its JSON so it can be fixed or removed. */
export interface UnreadableView { readable: false; key: string; revision: string; id?: string; reason: string; raw: string }
export type LibraryEntry = PipelineView | UnreadableView;

export interface AttachedView { key: string; revision: string; readable: boolean; name: string; text: string; libraryID?: string; missing?: boolean }
export interface SourceView {
  source: string;
  label: string;
  /** The folder is still watched for this type; false for pipelines left attached to a folder that is no longer listed. */
  configured: boolean;
  entries: AttachedView[];
}
export interface ZoneView {
  readable: boolean;
  key: string;
  revision: string;
  name: string;
  icon: string;
  type?: ClopFileType;
  /** The library pipeline the zone runs, or the text of its own pipeline. */
  libraryID?: string;
  pipelineName: string;
  text: string;
  /** The library pipeline it names is gone, so dropping on it does nothing. */
  missing?: boolean;
  reason?: string;
}
export interface EditorState {
  library: LibraryEntry[];
  attachments: Record<ClopFileType, SourceView[]>;
  zones: ZoneView[];
}

const prettyRaw = (raw: unknown) => { try { return JSON.stringify(typeof raw === 'string' ? JSON.parse(raw) : raw, null, 2); } catch { return String(raw); } };

/** A short fingerprint of a stored entry (cyrb53 of its JSON), to tell whether it changed since the window drew it. */
export function revisionOf(entry: unknown): string {
  const text = JSON.stringify(entry) ?? '';
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The key of each entry of a stored list, which commands name entries by: a readable entry's id; an unreadable entry's own id
 * when it has a short one, else a hash of what it holds. Never a position, which shifts whenever anything before it changes.
 * An id or content that repeats gets a key of its own (a repeated readable id gets `~2`, `~3`…), so every key is unique.
 */
export function entryKeys(entries: readonly Stored<{ id: string }>[]): string[] {
  const used = new Set<string>();
  return entries.map(entry => {
    if (isReadable(entry)) {
      let key = entry.id;
      for (let n = 2; used.has(key); n++) key = `${entry.id}~${n}`;
      used.add(key);
      return key;
    }
    const id = storedId(entry), hash = revisionOf(entry);
    let key = id !== undefined && id.length <= 64 ? `unreadable:id:${id}` : `unreadable:raw:${hash}`;
    if (used.has(key)) key = `unreadable:raw:${hash}`;
    for (let n = 2; used.has(key); n++) key = `unreadable:raw:${hash}~${n}`;
    used.add(key);
    return key;
  });
}

/** The text a stored pipeline shows: its own words when they still mean its steps, else the steps written out. */
export function textOf(pipeline: Pipeline): { text: string; exact: boolean } {
  const exact = pipeline.steps.every(canFormat);
  if (pipeline.rawText?.trim()) {
    const parsed = parsePipelineText(pipeline.rawText, { checkValues: false });
    if (!parsed.issues.length && JSON.stringify(parsed.steps) === JSON.stringify(pipeline.steps)) return { text: pipeline.rawText, exact };
  }
  return { text: exact ? formatSteps(pipeline.steps) : '', exact };
}

export function pipelineView(pipeline: Pipeline, key = pipeline.id): PipelineView {
  const { text, exact } = textOf(pipeline);
  return {
    readable: true, key, revision: revisionOf(pipeline), name: pipeline.name ?? '', builtin: isBuiltin(pipeline), fileType: pipeline.fileType, icon: pipeline.icon, details: pipeline.details,
    skipOptimisation: pipeline.skipOptimisation, hideResult: pipeline.hideResult, text, json: stepsToJsonc(pipeline.steps), exact,
    problems: pipelineProblems(pipeline).map(problem => `Step ${problem.step + 1}: ${problem.message}`),
  };
}
const libraryView = (saved: readonly Stored<Pipeline>[]): LibraryEntry[] => {
  const keys = entryKeys(saved);
  return saved.map((entry, index) => isReadable(entry) ? pipelineView(entry, keys[index])
    : { readable: false, key: keys[index], revision: revisionOf(entry), id: storedId(entry), reason: entry.reason, raw: prettyRaw(entry.raw) });
};

/** The entry of `map` stored for `source`: the same key, or one that names the same folder. */
export function sourceEntry<T>(map: Record<string, T>, source: string, { home, platform }: EditorContext = {}): { key: string; entries: T } | undefined {
  if (Object.hasOwn(map, source)) return { key: source, entries: map[source] };
  const wanted = sourceKey(source, home, platform), found = Object.keys(map).find(key => sourceKey(key, home, platform) === wanted);
  return found === undefined ? undefined : { key: found, entries: map[found] };
}

const SOURCE_LABELS: Record<string, string> = { clipboard: 'Clipboard', dropZone: 'Drop zone' };
function attachmentsView(settings: EditorSettings, context: EditorContext): Record<ClopFileType, SourceView[]> {
  const saved = settings.savedPipelines.filter(isReadable), result = {} as Record<ClopFileType, SourceView[]>;
  for (const kind of FILE_TYPES) {
    const map = settings[PIPELINE_SOURCE_KEYS[kind]] ?? {}, shown = new Set<string>();
    const view = (source: string, label: string, configured: boolean): SourceView => {
      const found = sourceEntry(map, source, context);
      if (found) shown.add(found.key);
      const keys = entryKeys(found?.entries ?? []);
      return {
        source, label, configured, entries: (found?.entries ?? []).map((entry, index): AttachedView => {
          if (!isReadable(entry)) return { key: keys[index], revision: revisionOf(entry), readable: false, name: 'Unreadable pipeline', text: entry.reason };
          const target = entry.libraryID === undefined ? entry : saved.find(candidate => candidate.id === entry.libraryID);
          return { key: keys[index], revision: revisionOf(entry), readable: true, libraryID: entry.libraryID, name: target?.name ?? (entry.libraryID ? 'Deleted pipeline' : 'Pipeline'), text: target ? textOf(target).text : '', ...(target ? {} : { missing: true }) };
        }),
      };
    };
    result[kind] = [...FIXED_SOURCES.map(source => view(source, SOURCE_LABELS[source], true)), ...settings[DIR_KEYS[kind]].map(dir => view(dir, dir, true))];
    for (const key of Object.keys(map)) if (!shown.has(key) && map[key].length) result[kind].push(view(key, key, false));
  }
  return result;
}

function zoneViews(settings: EditorSettings): ZoneView[] {
  const saved = settings.savedPipelines.filter(isReadable);
  const keys = entryKeys(settings.presetZones);
  return settings.presetZones.map((zone, index): ZoneView => {
    if (zone instanceof Unreadable) return { readable: false, key: keys[index], revision: revisionOf(zone), name: 'Unreadable preset zone', icon: '', pipelineName: '', text: '', reason: zone.reason };
    const target = resolveRunnable(zone.pipeline, saved);
    return {
      readable: true, key: keys[index], revision: revisionOf(zone), name: zone.name, icon: zone.icon, type: zone.type, libraryID: zone.pipeline.libraryID,
      pipelineName: target ? target.name ?? 'Custom pipeline' : 'Deleted pipeline', text: target ? textOf(target).text : '', ...(target ? {} : { missing: true }),
    };
  });
}

export const editorState = (settings: EditorSettings, context: EditorContext = {}): EditorState =>
  ({ library: libraryView(settings.savedPipelines), attachments: attachmentsView(settings, context), zones: zoneViews(settings) });
