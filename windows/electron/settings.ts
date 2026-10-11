import { SETTING_ENTRIES } from '../core/settings/entries';
import { settingsSchema, type ClopSettings, type CompressionQuality, type SettingKey, type SettingSpec } from '../core/settings/schema';
import type { ImageOptions } from '../src/types';
import { parseCropSize } from './crop';
import { shortcutProblem } from '../core/shortcuts';
export const modes = ['balanced', 'aggressive', 'lossless'] as const;
export const formats = ['auto', 'png', 'jpeg', 'webp', 'avif', 'gif', 'heic', 'jxl'] as const;
export function parseOptions(value: unknown): ImageOptions {
  if (!value || typeof value !== 'object') throw new Error('Choose image settings first.');
  const o = value as ImageOptions;
  if (!modes.includes(o.mode) || !formats.includes(o.format) || !Number.isFinite(o.scale) || o.scale < 0.1 || o.scale > 1) throw new Error('Use a scale between 10% and 100%.');
  if (o.maxEdge !== undefined && (!Number.isInteger(o.maxEdge) || o.maxEdge < 1 || o.maxEdge > 16000)) throw new Error('Use a longest edge between 1 and 16000 pixels.');
  const c = o.compression;
  if (c !== undefined && (!c || typeof c !== 'object' || !['adaptive', 'custom'].includes(c.tier) || !Number.isInteger(c.factor) || c.factor < 5 || c.factor > 100)) throw new Error('Use a compression factor between 5 and 100.');
  return { mode: o.mode, format: o.format, scale: o.scale, ...(o.maxEdge ? { maxEdge: o.maxEdge } : {}), ...(o.crop ? { crop: parseCropSize(o.crop) } : {}), ...(c ? { compression: { tier: c.tier, factor: c.factor } } : {}) };
}
/** The engine mode for a compression setting: aggressive from factor 50 as in `imageIsAggressive` (Shared.swift), lossless for the Windows-only tier. */
export function imageMode({ tier, factor }: CompressionQuality): ImageOptions['mode'] {
  return tier === 'lossless' ? 'lossless' : tier !== 'adaptive' && factor >= 50 ? 'aggressive' : 'balanced';
}
/**
 * The compression a card mode asks for, the inverse of `imageMode`. Balanced runs the configured
 * setting unless that is aggressive or lossless, aggressive is the macOS aggressive button (factor 64)
 * unless the setting already is aggressive, and lossless is the Windows-only lossless tier.
 */
export function imageCompression(mode: ImageOptions['mode'], configured: CompressionQuality): { compression: CompressionQuality; aggressive?: boolean } {
  if (mode === 'lossless') return { compression: { tier: 'lossless', factor: configured.factor } };
  return imageMode(configured) === mode ? { compression: configured } : { compression: configured, aggressive: mode === 'aggressive' };
}
export function imageDefaults(settings: ClopSettings): ImageOptions {
  return { mode: imageMode(settings.imageCompression), format: settings.defaultImageFormat, scale: 1 };
}
/**
 * Settings the Settings window edits only through a dedicated action of the main process, never as a raw value: programs and folders
 * come from a picker there, the ignored-apps list from the helper's app list or a picker, the MCP switches through their own confirmation,
 * and pipelines through the pipeline editor. A window that could write these could point Clop at any program, folder or script.
 */
export const ACTION_ONLY_SETTINGS = {
  editorAppImage: 'program picker', editorAppVideo: 'program picker', editorAppAudio: 'program picker', editorAppPDF: 'program picker',
  workdir: 'folder picker', imageDirs: 'folder picker', videoDirs: 'folder picker', audioDirs: 'folder picker', pdfDirs: 'folder picker', dirsHideFloatingResult: 'watched folder list',
  clipboardIgnoredAppBundleIds: 'app list or program picker',
  mcpEnabled: 'MCP action', mcpAllowScriptSteps: 'MCP action, which asks first',
  savedPipelines: 'pipeline editor', presetZones: 'pipeline editor', pipelinesToRunOnImage: 'pipeline editor', pipelinesToRunOnVideo: 'pipeline editor', pipelinesToRunOnAudio: 'pipeline editor', pipelinesToRunOnPdf: 'pipeline editor',
} as const satisfies Partial<Record<SettingKey, string>>;
/** The settings the renderer may change: every one the Settings window has a row for, except those that only change through an action. */
export const RENDERER_SETTINGS: readonly SettingKey[] = [...new Set(SETTING_ENTRIES.flatMap(entry => entry.keys))].filter(key => !(key in ACTION_ONLY_SETTINGS));
export function rendererSettings(value: unknown, current?: ClopSettings): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a setting to change.');
  const blocked = Object.keys(value).filter(key => !(RENDERER_SETTINGS as readonly string[]).includes(key));
  if (blocked.length) throw new Error(`${blocked.join(', ')} cannot be changed from this window.`);
  // The store ignores a value it cannot read; the window is told instead.
  const invalid = Object.entries(value).filter(([key, entry]) => (settingsSchema[key as SettingKey] as SettingSpec).parse(entry) === undefined).map(([key]) => key);
  if (invalid.length) throw new Error(`${invalid.join(', ')} ${invalid.length === 1 ? 'is not a valid value' : 'are not valid values'}.`);
  // Shortcuts that would take over typing (Shift alone) or that nothing can press are refused here, before they are saved.
  const problem = shortcutProblem(value, current);
  if (problem) throw new Error(problem);
  return value as Record<string, unknown>;
}
