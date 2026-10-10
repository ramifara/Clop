import type { ClopSettings, CompressionQuality, SettingKey } from '../core/settings/schema';
import type { ImageOptions } from '../src/types';
export const modes = ['balanced', 'aggressive', 'lossless'] as const;
export const formats = ['auto', 'png', 'jpeg', 'webp', 'avif', 'gif'] as const;
export function parseOptions(value: unknown): ImageOptions {
  if (!value || typeof value !== 'object') throw new Error('Choose image settings first.');
  const o = value as ImageOptions;
  if (!modes.includes(o.mode) || !formats.includes(o.format) || !Number.isFinite(o.scale) || o.scale < 0.1 || o.scale > 1) throw new Error('Use a scale between 10% and 100%.');
  if (o.maxEdge !== undefined && (!Number.isInteger(o.maxEdge) || o.maxEdge < 1 || o.maxEdge > 16000)) throw new Error('Use a longest edge between 1 and 16000 pixels.');
  return { mode: o.mode, format: o.format, scale: o.scale, ...(o.maxEdge ? { maxEdge: o.maxEdge } : {}) };
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
/** The settings the renderer may change: exactly what the settings window writes. Everything else (app paths, the work folder, MCP switches, pipelines) only changes from the main process. */
export const RENDERER_SETTINGS = ['enableClipboardOptimiser', 'optimiseImagePathClipboard', 'optimiseVideoClipboard', 'optimisePDFClipboard', 'optimiseAudioClipboard', 'autoCopyToClipboard', 'enableDragAndDrop', 'keepDropZoneVisible', 'floatingResultsAlwaysOnTop', 'launchAtLogin', 'floatingResultsCorner', 'defaultImageFormat', 'clipboardIgnoredAppBundleIds'] as const satisfies readonly SettingKey[];
export function rendererSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a setting to change.');
  const blocked = Object.keys(value).filter(key => !(RENDERER_SETTINGS as readonly string[]).includes(key));
  if (blocked.length) throw new Error(`${blocked.join(', ')} cannot be changed from this window.`);
  return value as Record<string, unknown>;
}
