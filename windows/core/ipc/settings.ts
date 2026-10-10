import { isDeepStrictEqual } from 'node:util';
import { COMPRESSION_TIERS, settingsSchema, SETTING_KEYS, type ClopSettings, type CompressionQuality, type SettingKey, type SettingSpec } from '../settings/schema';
import type { MCPSettingInfo, SettingsRequest, SettingsResponse } from './protocol';

// `MCPSettingsBridge` (Clop/MCPSettings.swift): every setting as an agent or `clop settings` sees it, each value as a
// string that can be written back unchanged, and the MCP gate. macOS words each row from the Settings window's search
// index; until the Windows settings window has one, a row is the key and its schema description.

/** What the settings bridge needs from a settings store. `SettingsStore` fits. */
export interface SettingsAccess { get(): ClopSettings; set(partial: unknown): Promise<ClopSettings> }

/** Switches only the user may flip: an agent that could turn them on would need no permission at all. */
const USER_ONLY: readonly SettingKey[] = ['mcpEnabled', 'mcpAllowScriptSteps'];
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
  if (s.type === 'list') return (value as string[]).join(', ');
  if (s.type === 'object') return JSON.stringify(value);
  return String(value);
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
    case 'number': return trimmed && Number.isFinite(Number(trimmed)) ? checked(Number(trimmed), `${key} takes a number of at least 0, not '${raw}'`) : { error: `${key} takes a number, not '${raw}'` };
    case 'string': return { value: raw };
    case 'enum': {
      const match = s.values?.find(v => String(v).toLowerCase() === lower);
      return match === undefined ? { error: `${key} takes one of: ${s.values?.join(', ')}. Got '${raw}'` } : checked(match, '');
    }
    case 'list': {
      const items = raw.split(',').map(item => item.trim()).filter(Boolean);
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
  if (!pipeline || settings.mcpAllowScriptSteps || !pipeline.includes('runScript')) return undefined;
  return 'Clop is not accepting script steps from agents, and this pipeline has a runScript step. Use a built-in step if one can do the job, or ask the user to allow script steps in Clop Settings, MCP.';
}

/** Answers a `SettingsRequest` (`MCPSettingsBridge.handle`), enforcing the MCP gate on writes. */
export async function handleSettingsRequest(req: SettingsRequest, store: SettingsAccess): Promise<SettingsResponse> {
  const settings = store.get(), writes = req.action === 'set' || req.action === 'update' || req.action === 'gate';
  if (writes) {
    const refusal = mcpRefusal(req.origin, req.pipeline, settings);
    if (refusal) return { ok: false, error: refusal };
  }
  switch (req.action) {
    case 'gate': return { ok: true };
    case 'schema': return { ok: true, settings: matchSettings(req.query ?? '').map(key => settingInfo(key, settings)) };
    case 'read': return { ok: true, values: JSON.parse(JSON.stringify(settings)) };
    case 'get':
      if (!req.key) return { ok: false, error: 'get needs a key' };
      if (!isKey(req.key)) return { ok: false, error: `no setting named '${req.key}'. Ask for the schema to see every key.` };
      return { ok: true, settings: [settingInfo(req.key, settings)] };
    case 'set': {
      if (!req.key || req.value === undefined) return { ok: false, error: 'set needs a key and a value' };
      if (!isKey(req.key)) return { ok: false, error: `no setting named '${req.key}'. Call the schema tool to see every key.` };
      if (req.origin === 'mcp' && USER_ONLY.includes(req.key)) return { ok: false, error: `${req.key} can only be changed by the user, in Clop Settings.` };
      const parsed = parseSettingValue(req.key, req.value, settings);
      if ('error' in parsed) return { ok: false, error: parsed.error };
      const next = await store.set({ [req.key]: parsed.value });
      return { ok: true, settings: [settingInfo(req.key, next)] };
    }
    case 'update': {
      const values = req.values ?? {};
      for (const [key, value] of Object.entries(values)) {
        if (!isKey(key)) return { ok: false, error: `no setting named '${key}'.` };
        if (req.origin === 'mcp' && USER_ONLY.includes(key)) return { ok: false, error: `${key} can only be changed by the user, in Clop Settings.` };
        if (spec(key).parse(value) === undefined) return { ok: false, error: `${key} does not accept that value.` };
      }
      await store.set(values);
      return { ok: true };
    }
  }
}
