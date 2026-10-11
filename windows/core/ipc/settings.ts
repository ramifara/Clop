import { isDeepStrictEqual } from 'node:util';
import { COMPRESSION_TIERS, settingsSchema, SETTING_KEYS, type ClopSettings, type CompressionQuality, type SettingKey, type SettingSpec } from '../settings/schema';
import { shortcutProblem } from '../shortcuts';
import { isReadable, type Stored } from '../pipeline/codec';
import { namesProgramByPath } from '../pipeline/app-resolve';
import { stepEntry, type Pipeline, type PipelineStep, type PresetZone } from '../pipeline/model';
import { parsePipelineText } from '../pipeline/parser';
import { SETTINGS_CHANGED, type MCPSettingInfo, type SettingsRequest, type SettingsResponse } from './protocol';

// `MCPSettingsBridge` (Clop/MCPSettings.swift): every setting as an agent or `clop settings` sees it, each value as a
// string that can be written back unchanged, and the MCP gate. macOS words each row from the Settings window's search
// index; until the Windows settings window has one, a row is the key and its schema description.

/**
 * What the settings bridge needs from a settings store. `SettingsStore` fits. Every write that depends on what is stored
 * (all of an agent's or the CLI's) goes through `update`, which runs after every write queued before it, so it cannot undo
 * what the pipeline editor or another command saved a moment earlier.
 */
export interface SettingsAccess {
  get(): ClopSettings;
  update<T>(change: (current: ClopSettings) => { patch?: unknown; result: T }): Promise<{ settings: ClopSettings; result: T }>;
}

/** Switches only the user may flip: an agent that could turn them on would need no permission at all. */
const USER_ONLY: readonly SettingKey[] = ['mcpEnabled', 'mcpAllowScriptSteps'];
/**
 * What an agent may change with `set`: the keys of the macOS bridge's registry (`MCPSettingsBridge.keys` in
 * Clop/MCPSettings.swift) that Windows uses, plus the Windows-only display switches. macOS also lets an agent write
 * `mcpAllowScriptSteps`; here it is the user's alone, since it is the very permission script steps need.
 */
export const MCP_WRITABLE: ReadonlySet<SettingKey> = new Set<SettingKey>([
  'optimisedImageBehaviour', 'optimisedVideoBehaviour', 'optimisedAudioBehaviour', 'optimisedPDFBehaviour', 'convertedImageBehaviour', 'convertedVideoBehaviour', 'convertedAudioBehaviour',
  'manualConvertedImageBehaviour', 'manualConvertedVideoBehaviour', 'manualConvertedAudioBehaviour', 'stripMetadata', 'preserveColorMetadata', 'preserveDates', 'optimisedFileProtectionMs',
  'enableClipboardOptimiser', 'optimiseTIFF', 'optimiseHEICAVIFClipboard', 'optimiseImagePathClipboard', 'optimiseVideoClipboard', 'optimiseAudioClipboard', 'optimisePDFClipboard',
  'appendClipboardResults', 'copyConsecutiveClipboardImages', 'clipboardAccumulationTimeout', 'removeAudioFromVideos', 'capVideoFPS', 'convertAudioToAAC', 'playbackSpeedFrameBehaviour',
  'copyImageFilePath', 'useCustomNameTemplateForClipboardImages', 'customNameTemplateForClipboardImages', 'gifFrameDropBehaviour', 'convertHDRToSDR', 'audioCoverArt', 'enableDragAndDrop',
  'onlyShowDropZoneOnOption', 'autoCopyToClipboard', 'useBatchModeForFolders', 'batchModeFileCountThreshold', 'onlyShowPresetZonesOnControlTapped', 'enableFloatingResults', 'followCursorScreen',
  'hideFloatingResultTooltips', 'alwaysShowCompactResults', 'showCopyClearButtons', 'dismissFloatingResultOnDrop', 'dismissFloatingResultOnUpload', 'autoHideFloatingResults',
  'autoHideFloatingResultsAfter', 'autoHideClipboardResultAfter', 'showCompactImages', 'dismissCompactResultOnDrop', 'dismissCompactResultOnUpload', 'autoClearAllCompactResultsAfter',
  'formatPickerStyle', 'floatingResultsCorner', 'enableAutomaticVideoOptimisations', 'minVideoSizeKB', 'maxVideoSizeMB', 'minVideoResolution', 'maxVideoResolution', 'maxVideoFileCount',
  'sameFolderNameTemplateVideo', 'specificFolderNameTemplateVideo', 'convertedSameFolderNameTemplateVideo', 'convertedSpecificFolderNameTemplateVideo', 'videoCompression', 'targetVideoFPS',
  'minVideoFPS', 'videoFormatsToSkip', 'formatsToConvertToMP4', 'enableAutomaticImageOptimisations', 'minImageSizeKB', 'maxImageSizeMB', 'minImageResolution', 'maxImageResolution',
  'maxImageFileCount', 'sameFolderNameTemplateImage', 'specificFolderNameTemplateImage', 'convertedSameFolderNameTemplateImage', 'convertedSpecificFolderNameTemplateImage', 'imageCompression',
  'imageFormatsToSkip', 'formatsToConvertToJPEG', 'formatsToConvertToPNG', 'enableAutomaticAudioOptimisations', 'minAudioSizeKB', 'maxAudioSizeMB', 'maxAudioFileCount',
  'sameFolderNameTemplateAudio', 'specificFolderNameTemplateAudio', 'convertedSameFolderNameTemplateAudio', 'convertedSpecificFolderNameTemplateAudio', 'audioCompression', 'formatsToConvertToAAC',
  'formatsToConvertToMP3', 'enableAutomaticPDFOptimisations', 'pdfDPI', 'minPDFSizeKB', 'maxPDFSizeMB', 'maxPDFFileCount', 'sameFolderNameTemplatePDF', 'specificFolderNameTemplatePDF', 'workdir',
  'showMenubarIcon', 'allowClopToAppearInScreenshots', 'pauseAutomaticOptimisations', 'floatingResultActions', 'compactResultActions',
  // Windows only.
  'keepDropZoneVisible', 'floatingResultsAlwaysOnTop', 'launchAtLogin', 'defaultImageFormat', 'persistDebugLogs',
]);
/** Programs Clop starts ("Edit with"). On macOS they are writable like any setting; an exe path runs anything, so here an agent needs the script permission for them. */
const PROGRAM_KEYS: readonly SettingKey[] = ['editorAppImage', 'editorAppVideo', 'editorAppPDF', 'editorAppAudio'];
/** What `clop pipeline add|attach|detach|preset` write. An agent may change these only through `update`, after its pipelines are checked for script steps. */
const LIBRARY_KEYS: readonly SettingKey[] = [
  'savedPipelines', 'presetZones', 'pipelinesToRunOnImage', 'pipelinesToRunOnVideo', 'pipelinesToRunOnPdf', 'pipelinesToRunOnAudio',
  'imageDirs', 'videoDirs', 'pdfDirs', 'audioDirs', 'enableAutomaticImageOptimisations', 'enableAutomaticVideoOptimisations', 'enableAutomaticPDFOptimisations', 'enableAutomaticAudioOptimisations',
];
/** Steps that run code: `runScript`, and `runShortcut`, which on Windows runs a script or program of that name. */
const SCRIPT_STEP = /\brun(Script|Shortcut)\b/;
const SCRIPT_KINDS: readonly string[] = ['runScript', 'runShortcut'];
/** Steps that open the file with an app. Named by an exe path or any other path, the app is a program Clop starts: as much a script as `runScript`. */
const OPEN_KINDS: readonly string[] = ['openWith', 'shelveWith', 'uploadWith'];
/** A call in text, whatever its arguments look like: `kind` and everything up to the closing bracket, if there is one. */
const OPEN_STEP = /\b(openWith|shelveWith|uploadWith)\s*\(([^)]*)/g;
const scriptRefusal = (what: string) => `Clop is not accepting script steps from agents, and this pipeline has ${what}. Use a built-in step if one can do the job, or ask the user to allow script steps in Clop Settings, MCP.`;
const spec = (key: SettingKey) => settingsSchema[key] as SettingSpec;
const isCompression = (key: SettingKey) => spec(key).type === 'object' && isDeepStrictEqual(Object.keys(spec(key).default as object).sort(), ['factor', 'tier']);
/** Keys `clop settings` shows: everything Windows uses. */
export const VISIBLE_KEYS = SETTING_KEYS.filter(key => !spec(key).unsupportedOnWindows);

function typeOf(key: SettingKey): string {
  const { type, default: value } = spec(key);
  if (isCompression(key)) return 'compression';
  if (type === 'integer') return value === null ? 'int?' : 'int';
  return { boolean: 'bool', number: 'number', string: 'string', enum: 'enum', list: 'list', object: 'json' }[type] ?? type;
}

function allowed(key: SettingKey): string[] | undefined {
  const s = spec(key);
  if (s.type === 'boolean') return ['true', 'false'];
  if (isCompression(key)) return [...COMPRESSION_TIERS, '<tier>:<0-100>', '<0-100>'];
  return s.values?.map(String);
}

/** The string form of a stored value: what `settings get` prints and `settings set` takes back. */
export function formatSettingValue(key: SettingKey, value: unknown): string {
  const s = spec(key);
  if (isCompression(key)) { const c = value as CompressionQuality; return `${c.tier}:${c.factor}`; }
  if (value === null || value === undefined) return '';
  // Commas are valid in paths, so a list that holds one is printed as the JSON array `set` also reads.
  if (s.type === 'list') { const items = value as string[]; return items.some(item => item.includes(',')) || items[0]?.startsWith('[') ? JSON.stringify(items) : items.join(', '); }
  if (s.type === 'object') return JSON.stringify(value);
  return String(value);
}

/** A list written as a JSON array of strings, which can hold the commas that the plain form splits on. */
function jsonList(text: string): string[] | undefined {
  if (!text.startsWith('[')) return undefined;
  try { const value: unknown = JSON.parse(text); return Array.isArray(value) && value.every(item => typeof item === 'string') ? value.map(item => item.trim()).filter(Boolean) : undefined; } catch { return undefined; }
}

/** Parses the string form of `key`. Returns the stored value, or a sentence saying what the key takes. */
export function parseSettingValue(key: SettingKey, raw: string, current: ClopSettings): { value: unknown } | { error: string } {
  const s = spec(key), trimmed = raw.trim(), lower = trimmed.toLowerCase();
  const checked = (value: unknown, error: string) => { const parsed = s.parse(value); return parsed === undefined ? { error } : { value: parsed }; };
  if (isCompression(key)) {
    const parts = lower.split(':', 2).map(part => part.trim()), now = current[key] as unknown as CompressionQuality;
    if (parts.length === 1 && /^\d+$/.test(parts[0])) return checked({ tier: now.tier, factor: Number(parts[0]) }, `${key}'s factor is a whole number from 0 to 100. Got '${raw}'`);
    const tier = COMPRESSION_TIERS.find(t => t.toLowerCase() === parts[0]);
    if (!tier) return { error: `${key} takes one of: ${COMPRESSION_TIERS.join(', ')}, optionally followed by :factor. Got '${raw}'` };
    if (parts.length === 1) return { value: { tier, factor: now.factor } };
    const factor = Number(parts[1]);
    return /^\d+$/.test(parts[1]) && factor <= 100 ? { value: { tier, factor } } : { error: `${key}'s factor is a whole number from 0 to 100. Got '${parts[1]}'` };
  }
  switch (s.type) {
    case 'boolean':
      if (['true', 'yes', 'on', '1'].includes(lower)) return { value: true };
      if (['false', 'no', 'off', '0'].includes(lower)) return { value: false };
      return { error: `${key} takes true or false, not '${raw}'` };
    case 'integer':
      if (s.default === null && (!trimmed || ['none', 'off', 'unlimited', 'no limit'].includes(lower))) return checked(null, '');
      return /^-?\d+$/.test(trimmed) ? checked(Number(trimmed), `${key} takes a whole number${s.min !== undefined ? ` from ${s.min}` : ''}${s.max !== undefined ? ` to ${s.max}` : ''}, not '${raw}'`) : { error: `${key} takes a whole number, not '${raw}'` };
    case 'number': return trimmed && Number.isFinite(Number(trimmed)) ? checked(Number(trimmed), `${key} takes a number of at least 0${s.min !== undefined && s.min < 0 ? ', or -2 or -4 for a half or a quarter of the video\'s rate' : ''}, not '${raw}'`) : { error: `${key} takes a number, not '${raw}'` };
    case 'string': return { value: raw };
    case 'enum': {
      const match = s.values?.find(v => String(v).toLowerCase() === lower);
      return match === undefined ? { error: `${key} takes one of: ${s.values?.join(', ')}. Got '${raw}'` } : checked(match, '');
    }
    case 'list': {
      const items = jsonList(trimmed) ?? raw.split(',').map(item => item.trim()).filter(Boolean);
      const unknown = s.values ? items.filter(item => !s.values!.includes(item)) : [];
      if (unknown.length) return { error: `${key} does not know ${unknown.join(', ')}. It takes any of: ${s.values!.join(', ')}` };
      return checked(items, `${key} does not accept ${raw}.`);
    }
    default: {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return { error: `${key} takes JSON, as \`clop settings get ${key}\` prints it.` }; }
      return checked(value, `${key} does not accept that value. Read it with \`clop settings get ${key}\` for its shape.`);
    }
  }
}

export function settingInfo(key: SettingKey, settings: ClopSettings): MCPSettingInfo {
  const info: MCPSettingInfo = { key, type: typeOf(key), value: formatSettingValue(key, settings[key]), title: key, subtitle: spec(key).description, keywords: [], pane: '', section: '', entryID: key };
  const values = allowed(key);
  return values ? { ...info, allowed: values } : info;
}

const words = (text: string) => text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1);
/** `MCPSettingsBridge.matches`: rows holding every word first, then the rows that hold the most of them. */
export function matchSettings(query: string, keys: readonly SettingKey[] = VISIBLE_KEYS): SettingKey[] {
  const wanted = words(query);
  if (!wanted.length) return [...keys];
  const scored = keys.map(key => {
    const haystack = new Set([...words(key), ...words(spec(key).description)]);
    const hits = wanted.filter(word => haystack.has(word) || [...haystack].some(have => have.startsWith(word) && word.length > 3)).length;
    return { key, hits };
  });
  const strict = scored.filter(s => s.hits === wanted.length).map(s => s.key);
  const relaxed = scored.filter(s => s.hits > 0 && s.hits < wanted.length).sort((a, b) => b.hits - a.hits).slice(0, 20).map(s => s.key);
  return [...strict, ...relaxed];
}

const isKey = (key: string | undefined): key is SettingKey => !!key && Object.hasOwn(settingsSchema, key);

/** `mcpRefusal`: why a request from the MCP server may not run, or undefined when it may. Anyone else needs no permission. */
export function mcpRefusal(origin: string | undefined, pipeline: string | undefined, settings: Pick<ClopSettings, 'mcpEnabled' | 'mcpAllowScriptSteps'>): string | undefined {
  if (origin !== 'mcp') return undefined;
  if (!settings.mcpEnabled) return 'Clop is not accepting changes from agents. Ask the user to allow it in Clop Settings, MCP.';
  if (!pipeline || settings.mcpAllowScriptSteps) return undefined;
  const step = SCRIPT_STEP.exec(pipeline)?.[0] ?? undefined;
  const what = step ? `a ${step} step` : openedByPath(pipeline);
  return what ? scriptRefusal(what) : undefined;
}

/** The first `openWith`, `shelveWith` or `uploadWith` in pipeline text that names a program by path. Text that does not parse is judged by its own words. */
function openedByPath(text: string): string | undefined {
  if (!/\b(?:openWith|shelveWith|uploadWith)\b/.test(text)) return undefined;
  try {
    const { steps, issues } = parsePipelineText(text, { checkValues: false });
    const found = steps.map(scriptClass).find(Boolean);
    if (found || !issues.length) return found;
  } catch { /* Judged by the words below. */ }
  for (const [, kind, args] of text.matchAll(OPEN_STEP)) if (namesProgramByPath(args.replace(/^\s*app\s*:/, ''))) return `an ${kind} step that names a program by path`;
  return undefined;
}

/** The pipelines of a decoded library value, grouped by where they sit: one group per watched source, one for the library or the zones. */
function placedPipelines(key: SettingKey, decoded: unknown): Map<string, Stored<Pipeline>[]> {
  if (key === 'savedPipelines') return new Map([['', decoded as Stored<Pipeline>[]]]);
  if (key === 'presetZones') return new Map([['', (decoded as Stored<PresetZone>[]).map(zone => isReadable(zone) ? zone.pipeline : zone)]]);
  if (key.startsWith('pipelinesToRunOn')) return new Map(Object.entries(decoded as Record<string, Stored<Pipeline>[]>));
  return new Map();
}
/** What makes a step script-class, in words for the refusal: it runs code, or opens a program by path. */
function scriptClass(step: PipelineStep): string | undefined {
  const [kind, params] = stepEntry(step), app = (params as { app?: unknown } | undefined)?.app;
  if (SCRIPT_KINDS.includes(kind)) return `a ${kind} step`;
  return OPEN_KINDS.includes(kind) && typeof app === 'string' && namesProgramByPath(app) ? `an ${kind} step that names a program by path` : undefined;
}
const scriptKind = (pipeline: Pipeline) => pipeline.steps.map(scriptClass).find(Boolean);

/**
 * An agent's library write: refused, unless the user allowed script steps, when it puts a pipeline with a script step
 * somewhere it was not before, or points a reference at a saved pipeline with one. Every value is decoded exactly as the
 * app will read it (`settingsSchema[key].parse`), so legacy shapes and escaped JSON strings are judged by the steps they
 * become, never by their text. Newness is per key and source, so moving an attachment to another folder, file type or
 * the clipboard counts as new. A reference is judged by every saved pipeline with its id when it is new, and by the one
 * it runs (`resolvePipeline`) when a library change moves it. An entry this version cannot read cannot be checked, so an
 * agent may not add one.
 */
function libraryRefusal(values: Record<string, unknown>, settings: ClopSettings): string | undefined {
  if (settings.mcpAllowScriptSteps) return undefined;
  const json = (value: unknown) => JSON.stringify(value) ?? '';
  // Both sides are decoded the same way, so an entry the agent left as it was compares equal however it was sent.
  const before = (key: SettingKey) => spec(key).parse(settings[key]) ?? settings[key];
  const after = (key: SettingKey) => key in values ? spec(key).parse(values[key]) : before(key);
  const savedBefore = (before('savedPipelines') as Stored<Pipeline>[]).filter(isReadable);
  const savedAfter = (after('savedPipelines') as Stored<Pipeline>[]).filter(isReadable);
  const resolved = (entry: Pipeline, saved: Pipeline[]) => entry.libraryID === undefined ? undefined : saved.find(other => other.id === entry.libraryID);
  for (const key of LIBRARY_KEYS) {
    const was = placedPipelines(key, before(key));
    for (const [place, entries] of placedPipelines(key, after(key))) {
      const known = new Set((was.get(place) ?? []).map(json));
      for (const entry of entries) {
        if (!known.has(json(entry))) {
          if (!isReadable(entry)) return `Clop cannot read one of the pipelines in this change (${entry.reason}), so it cannot check it for script steps. Agents may only save pipelines Clop can read.`;
          const targets = entry.libraryID === undefined ? [] : [...savedBefore, ...savedAfter].filter(other => other.id === entry.libraryID);
          const step = scriptKind(entry) ?? targets.map(scriptKind).find(Boolean);
          if (step) return scriptRefusal(step);
        } else if (isReadable(entry)) {
          const target = resolved(entry, savedAfter);
          const step = target && json(target) !== json(resolved(entry, savedBefore)) ? scriptKind(target) : undefined;
          if (step) return scriptRefusal(step);
        }
      }
    }
  }
  return undefined;
}

/** Why an agent may not write `key`, or undefined when it may. */
function keyRefusal(key: SettingKey, settings: ClopSettings, viaLibrary: boolean): string | undefined {
  if (USER_ONLY.includes(key)) return `${key} can only be changed by the user, in Clop Settings.`;
  if (PROGRAM_KEYS.includes(key)) return settings.mcpAllowScriptSteps ? undefined : `${key} names a program for Clop to start, which agents may only change when the user allows script steps in Clop Settings, MCP.`;
  if (MCP_WRITABLE.has(key) || (viaLibrary && LIBRARY_KEYS.includes(key))) return undefined;
  return `${key} cannot be changed by agents.`;
}

/** What a write's checks come to: the reason it is refused, or nothing. */
type Refusal = { error: string } | undefined;
const refuse = (error: string) => ({ result: { error } as Refusal });
/** Whether `current` still holds, for every key in `base`, the value the client based its change on. Both are compared as JSON, as `read` sends them. */
const unchanged = (base: Record<string, unknown>, current: ClopSettings) => Object.entries(base).every(([key, value]) => isKey(key) && isDeepStrictEqual(JSON.parse(JSON.stringify(current[key])), value));

/** Answers a `SettingsRequest` (`MCPSettingsBridge.handle`), enforcing the MCP gate on writes. Writes are checked against the settings as they are when their turn comes. */
export async function handleSettingsRequest(req: SettingsRequest, store: SettingsAccess): Promise<SettingsResponse> {
  const settings = store.get();
  switch (req.action) {
    case 'gate': {
      const refusal = mcpRefusal(req.origin, req.pipeline, settings);
      return refusal ? { ok: false, error: refusal } : { ok: true };
    }
    case 'schema': return { ok: true, settings: matchSettings(req.query ?? '').map(key => settingInfo(key, settings)) };
    case 'read': return { ok: true, values: JSON.parse(JSON.stringify(settings)) };
    case 'get':
      if (!req.key) return { ok: false, error: 'get needs a key' };
      if (!isKey(req.key)) return { ok: false, error: `no setting named '${req.key}'. Ask for the schema to see every key.` };
      return { ok: true, settings: [settingInfo(req.key, settings)] };
    case 'set': {
      const written = await store.update((current): { patch?: unknown; result: Refusal } => {
        const gate = mcpRefusal(req.origin, req.pipeline, current);
        if (gate) return refuse(gate);
        if (!req.key || req.value === undefined) return refuse('set needs a key and a value');
        if (!isKey(req.key)) return refuse(`no setting named '${req.key}'. Call the schema tool to see every key.`);
        const refused = req.origin === 'mcp' ? keyRefusal(req.key, current, false) : undefined;
        if (refused) return refuse(refused);
        const parsed = parseSettingValue(req.key, req.value, current);
        if ('error' in parsed) return refuse(parsed.error);
        const unusable = shortcutProblem({ [req.key]: parsed.value }, current);
        if (unusable) return refuse(unusable);
        return { patch: { [req.key]: parsed.value }, result: undefined };
      });
      return written.result ? { ok: false, error: written.result.error } : { ok: true, settings: [settingInfo(req.key as SettingKey, written.settings)] };
    }
    case 'update': {
      const values = req.values ?? {};
      const written = await store.update((current): { patch?: unknown; result: Refusal } => {
        const gate = mcpRefusal(req.origin, req.pipeline, current);
        if (gate) return refuse(gate);
        for (const [key, value] of Object.entries(values)) {
          if (!isKey(key)) return refuse(`no setting named '${key}'.`);
          const refused = req.origin === 'mcp' ? keyRefusal(key, current, true) : undefined;
          if (refused) return refuse(refused);
          if (spec(key).parse(value) === undefined) return refuse(`${key} does not accept that value.`);
        }
        // The payload itself is checked: the `pipeline` text an agent sends alongside proves nothing.
        const refusal = req.origin === 'mcp' ? libraryRefusal(values, current) : undefined;
        if (refusal) return refuse(refusal);
        if (req.base && !unchanged(req.base, current)) return refuse(SETTINGS_CHANGED);
        const unusable = shortcutProblem(Object.fromEntries((['keyComboModifiers', 'enabledKeys', 'quickResizeKeys'] as const).filter(key => key in values).map(key => [key, spec(key).parse(values[key])])), current);
        if (unusable) return refuse(unusable);
        return { patch: values, result: undefined };
      });
      return written.result ? { ok: false, error: written.result.error } : { ok: true };
    }
  }
}
