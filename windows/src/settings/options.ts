import type { SettingKey } from '../../core/settings/schema';

// The choices the Settings window offers for list-valued and preset settings (the macOS lists in Settings.swift, with the
// extensions Windows Clop reads; `core/media/detect.ts` holds the full set).

const IMAGES = ['png', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'jxl', 'bmp', 'tiff'];
const VIDEOS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mpg', 'm2v'];
const AUDIO = ['mp3', 'm4a', 'aac', 'wav', 'aiff', 'flac', 'ogg', 'opus'];
const without = (list: string[], ...removed: string[]) => list.filter(item => !removed.includes(item));

/** The extensions a format list can hold, by setting. A value already stored but not offered here is still shown, so saving never drops it. */
export const FORMAT_OPTIONS: Partial<Record<SettingKey, string[]>> = {
  imageFormatsToSkip: IMAGES, videoFormatsToSkip: VIDEOS, audioFormatsToSkip: AUDIO,
  formatsToConvertToJPEG: without(IMAGES, 'png', 'jpeg', 'gif'), formatsToConvertToPNG: without(IMAGES, 'png', 'jpeg', 'gif'),
  formatsToConvertToMP4: without(VIDEOS, 'mp4'),
  formatsToConvertToAAC: without(AUDIO, 'mp3', 'm4a', 'aac'), formatsToConvertToMP3: without(AUDIO, 'mp3', 'm4a', 'aac'), formatsToConvertToOutputAudio: AUDIO,
};

export const ACTION_LABELS: Record<string, string> = {
  downscale: 'Downscale', compression: 'Compression', crop: 'Crop and resize', share: 'Share', restoreOptimise: 'Restore or optimise', aggressiveOptimisation: 'Aggressive optimisation',
  copyToClipboard: 'Copy to clipboard', showInFinder: 'Show in Explorer', quickLook: 'Preview', saveAs: 'Save as…', addToShelf: 'Add to shelf', sendSecurely: 'Send securely', targetSize: 'Target size',
};
/** Actions with nothing behind them on Windows (a shelf app is a Mac thing) are not offered, but one already in a list stays. */
export const OFFERED_ACTIONS = Object.keys(ACTION_LABELS).filter(name => name !== 'addToShelf');

/** The global shortcuts' action keys, as `KeysSettingsView.swift` lists them. */
export const ACTION_KEYS = [
  { key: '-', name: 'Downscale', description: 'Decrease resolution of the last image or video' },
  { key: 'X', name: 'Speed up video', description: 'Make video playback faster by dropping frames' },
  { key: 'Backspace', name: 'Stop and dismiss', description: 'Stop the last running action and dismiss the floating result' },
  { key: 'Escape', name: 'Stop and clear all', description: 'Stop running optimisations and clear all floating results' },
  { key: '=', name: 'Bring back', description: 'Bring back the last removed floating result' },
  { key: 'Space', name: 'Preview', description: 'Preview the latest image or video' },
  { key: 'R', name: 'Rename', description: 'Rename the file of the latest image or video' },
  { key: 'Z', name: 'Restore original', description: 'Revert optimisations and downscaling actions done on the latest image or video' },
  { key: 'P', name: 'Pause optimisations', description: 'Pause or stop automatic optimisations' },
  { key: 'C', name: 'Optimise current clipboard', description: 'Apply optimisations on the copied image, URL or path' },
  { key: 'A', name: 'Optimise aggressively', description: 'Apply aggressive optimisations on the copied image, URL or path' },
] as const;
/** `RESIZE_KEYS`: the number keys 1 to 9, each downscaling to that many tenths. */
export const RESIZE_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export const PDF_DPI_PRESETS = [0, 72, 96, 150, 200, 300] as const;
/** `targetVideoFPS`: positive is a cap, -2 and -4 are fractions of the source's rate. */
export const FPS_CAPS = [{ value: 30, label: '30 fps' }, { value: 60, label: '60 fps' }, { value: -2, label: '1/2 of source' }, { value: -4, label: '1/4 of source' }] as const;
export const MIN_FPS = [10, 24, 30, 60] as const;

/** The variables a name template understands, as `FileNameTemplate.swift` lists them. */
export const TEMPLATE_VARIABLES = [
  ['%y', 'Year'], ['%m', 'Month'], ['%n', 'Month name'], ['%d', 'Day'], ['%w', 'Weekday'], ['%H', 'Hour'], ['%M', 'Minutes'], ['%S', 'Seconds'], ['%p', 'AM or PM'],
  ['%r', 'Random letters'], ['%i', 'Auto-incrementing number'], ['%f', 'File name'], ['%e', 'Extension'], ['%P', 'Folder'], ['%F', 'Full path'],
] as const;
