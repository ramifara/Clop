import path from 'node:path';
import { DEFAULT_CROP_SIZES } from '../data/cropSizes';
import { defaultPaths, portablePath, type DefaultPaths } from './paths';

// Every key from Clop/Settings.swift keeps its macOS name, so `clop settings get/set` and the MCP
// settings tools speak the same names on both platforms. Defaults are copied from the Swift
// declarations. Where Windows stores a value differently, `encoding` says how. Paths may start with
// `~` or `$HOME`; resolve them with `expandHome` before touching the filesystem.

export type SettingType = 'boolean' | 'integer' | 'number' | 'string' | 'enum' | 'list' | 'object';
type Default<T> = T | ((paths: DefaultPaths) => T);
interface Flags {
  /** Not a macOS key. */
  windowsOnly?: true;
  /** A macOS key whose feature is not ported (licence, Photos, iCloud, menubar icon variants…). Kept so imported settings round-trip; the UI hides it. */
  unsupportedOnWindows?: true;
  /** How the Windows value differs from what macOS stores. */
  encoding?: string;
}
export interface SettingSpec<T = unknown> extends Flags {
  type: SettingType;
  default: Default<T>;
  description: string;
  /** Allowed values of an `enum`, or allowed items of a `list`. */
  values?: readonly (string | number)[];
  min?: number;
  max?: number;
  /** The value in this setting's Windows encoding, or undefined when it is not acceptable. */
  parse(value: unknown): T | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const spec = <T>(type: SettingType, value: Default<T>, description: string, parse: (value: unknown) => T | undefined, extra: Omit<Partial<SettingSpec<T>>, 'parse'> = {}): SettingSpec<T> => ({ type, default: value, description, ...extra, parse });

const bool = (value: boolean, description: string, flags?: Flags) => spec('boolean', value, description, v => typeof v === 'boolean' ? v : undefined, flags);
const str = (value: Default<string>, description: string, flags?: Flags) => spec('string', value, description, v => typeof v === 'string' ? v : undefined, flags);
function int(value: number, description: string, { min = 0, max, ...flags }: Flags & { min?: number; max?: number } = {}) {
  return spec('integer', value, description, v => Number.isInteger(v) && (v as number) >= min && (max === undefined || (v as number) <= max) ? v as number : undefined, { min, max, ...flags });
}
const num = (value: number, description: string, flags?: Flags) => spec('number', value, description, v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined, { min: 0, ...flags });
function oneOf<const V extends readonly (string | number)[]>(values: V, value: V[number], description: string, flags?: Flags) {
  return spec<V[number]>('enum', value, description, v => values.includes(v as V[number]) ? v as V[number] : undefined, { values, ...flags });
}
function list(value: Default<string[]>, description: string, { values, item, unique, ...flags }: Flags & { values?: readonly string[]; item?: RegExp; unique?: boolean } = {}) {
  const valid = (v: unknown) => typeof v === 'string' && (!values || values.includes(v)) && (!item || item.test(v));
  return spec('list', value, description, v => Array.isArray(v) && v.every(valid) ? unique ? [...new Set(v as string[])] : [...v as string[]] : undefined, { values, ...flags });
}
/** Values whose model belongs to a later module (pipelines, preset zones). Stored as plain JSON and only shallow-checked (an array, or a map of arrays) until the pipeline model (Task 11) validates them. */
function json<T>(value: T, description: string, check: (value: unknown) => boolean, flags?: Flags) {
  return spec<T>('object', value, description, v => check(v) ? JSON.parse(JSON.stringify(v)) as T : undefined, flags);
}

const FILE_BEHAVIOURS = ['temporary', 'inPlace', 'sameFolder', 'specificFolder'] as const;
const behaviour = (value: (typeof FILE_BEHAVIOURS)[number], description: string) => oneOf(FILE_BEHAVIOURS, value, `${description} macOS: \`FileBehaviour\`.`);

const EXTENSIONS = { item: /^[a-z0-9]{1,10}$/, unique: true, encoding: 'Lowercase file extensions without the dot, as the macOS MCP bridge prints them; macOS stores UTType identifiers.' } as const;
const formats = (value: string[], description: string) => list(value, `${description} macOS: \`Set<UTType>\`.`, EXTENSIONS);

export const COMPRESSION_TIERS = ['adaptive', 'lossless', 'fast', 'smaller', 'custom'] as const;
export interface CompressionQuality { tier: (typeof COMPRESSION_TIERS)[number]; factor: number }
/** Mirrors the tolerant `CompressionQuality` decoder: a missing tier is `custom`, a missing factor 50, and the factor is clamped to 0–100. */
const compression = (value: CompressionQuality, description: string, flags?: Flags) => spec<CompressionQuality>('object', value, `${description} The factor runs 5–100; 0 means auto (video only), and stored values are clamped to 0–100 as the macOS decoder does. macOS: \`CompressionQuality\`.`, v => {
  if (!isRecord(v)) return undefined;
  const tier = COMPRESSION_TIERS.includes(v.tier as CompressionQuality['tier']) ? v.tier as CompressionQuality['tier'] : 'custom';
  return { tier, factor: Number.isInteger(v.factor) ? Math.max(0, Math.min(100, v.factor as number)) : 50 };
}, flags);

export interface CropSize { width: number; height: number; name: string; longEdge: boolean; smartCrop: boolean; isAspectRatio?: boolean; cropRect?: { x: number; y: number; width: number; height: number } }
const isCropSize = (v: unknown) => isRecord(v) && Number.isInteger(v.width) && Number.isInteger(v.height) && typeof v.name === 'string' && typeof v.longEdge === 'boolean' && typeof v.smartCrop === 'boolean'
  && (v.isAspectRatio === undefined || typeof v.isAspectRatio === 'boolean')
  && (v.cropRect === undefined || (isRecord(v.cropRect) && ['x', 'y', 'width', 'height'].every(k => Number.isFinite((v.cropRect as Record<string, unknown>)[k]))));

const FLOATING_ACTIONS = ['downscale', 'compression', 'crop', 'share', 'restoreOptimise', 'aggressiveOptimisation', 'copyToClipboard', 'showInFinder', 'quickLook', 'saveAs', 'addToShelf', 'sendSecurely', 'targetSize'];
const actions = (value: string[], description: string) => list(value, `${description} Built-in action names, or \`pipeline:image=<id>;video=<id>\`. macOS: \`[FloatingAction]\`.`, { item: new RegExp(`^(${FLOATING_ACTIONS.join('|')}|pipeline:.+)$`) });

export const KEY_MODIFIERS = ['Control', 'Shift', 'Alt', 'Super'] as const;
/** Electron accelerator key codes (https://www.electronjs.org/docs/latest/api/accelerator#available-key-codes) that a shortcut can end with. */
const ACCELERATOR_KEY = /^([A-Z0-9]|F([1-9]|1\d|2[0-4])|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|PrintScreen|[-=[\]\\;',./`])$/;
const shortcutKeys = (value: string[], description: string) => list(value, `${description} macOS: \`[SauceKey]\`.`, { item: ACCELERATOR_KEY, unique: true, encoding: 'Electron accelerator key codes (`C`, `Space`, `-`); macOS stores SauceKey key codes.' });

export const VIDEO_ENCODERS = ['auto', 'libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf'] as const;
/** macOS stores `fast | slowHighQuality | visuallyLossless` (VideoToolbox presets); imported settings and `hevc_videotoolbox` fall back to `auto`, since `videoCompression` carries the quality. */
const MAC_VIDEO_ENCODERS = ['fast', 'slowHighQuality', 'visuallyLossless', 'hevc_videotoolbox'];
const videoEncoder = spec<(typeof VIDEO_ENCODERS)[number]>('enum', 'auto', 'Video encoder. `auto` picks a hardware encoder when one is available. macOS: `VideoEncoder`.',
  v => VIDEO_ENCODERS.includes(v as (typeof VIDEO_ENCODERS)[number]) ? v as (typeof VIDEO_ENCODERS)[number] : MAC_VIDEO_ENCODERS.includes(v as string) ? 'auto' : undefined,
  { values: VIDEO_ENCODERS, encoding: 'FFmpeg encoder name or `auto`; the macOS presets and `hevc_videotoolbox` map to `auto`.' });

const UNSUPPORTED = { unsupportedOnWindows: true } as const;
const EXE = { encoding: 'Path to an .exe; empty uses the Windows default app. macOS stores an app path.' } as const;
const DIRS = { encoding: 'Folder paths; a leading `~` or `$HOME` means the user profile folder. Defaults are stored that way (`~/Desktop`).' } as const;
const NORMAL = 30, AGGRESSIVE = 64; // COMPRESSION_FACTOR_NORMAL and _AGGRESSIVE in Shared.swift
const isPipelineMap = (v: unknown) => isRecord(v) && Object.values(v).every(Array.isArray);

export const settingsSchema = {
  finishedOnboarding: bool(false, 'The first-run introduction has been shown.'),
  showMenubarIcon: bool(true, 'Show the tray icon (the macOS menubar icon).'),
  useClassicMenubarIcon: bool(false, 'Use the classic menubar icon.', UNSUPPORTED),
  useGeometricMenubarIcon: bool(false, 'Use the geometric menubar icon.', UNSUPPORTED),
  defaultLinkExpiration: num(3600, 'Seconds a share link stays alive. macOS: `TimeInterval`.'),
  enableFloatingResults: bool(true, 'Show floating results. Off keeps optimising in the background without UI.'),
  alwaysShowCompactResults: bool(false, 'Always use the compact results layout.'),
  hideFloatingResultTooltips: bool(false, 'Hide the labels that pop up over result buttons.'),
  optimiseTIFF: bool(true, 'Optimise copied TIFF data.'),
  optimiseHEICAVIFClipboard: bool(false, 'Optimise copied HEIC and AVIF data.'),
  enableClipboardOptimiser: bool(true, 'Watch the clipboard and optimise copied data automatically. Legacy Windows key: `clipboard`.'),
  clipboardIgnoredAppBundleIds: list([], 'Apps whose clipboard copies are ignored. macOS: `Set<String>` of bundle IDs.', { unique: true, encoding: 'Executable paths or AUMIDs instead of bundle IDs.' }),
  optimiseVideoClipboard: bool(false, 'Optimise copied video files.'),
  optimiseAudioClipboard: bool(false, 'Optimise copied audio files.'),
  optimisePDFClipboard: bool(false, 'Optimise copied PDF files.'),
  optimiseImagePathClipboard: bool(false, 'Optimise copied image files (paths rather than image data).'),
  stripMetadata: bool(true, 'Strip identifying EXIF metadata.'),
  preserveDates: bool(true, 'Keep the original creation and modification dates.'),
  preserveColorMetadata: bool(true, 'Keep colour profile tags when stripping metadata.'),
  useBatchModeForFolders: bool(true, 'Large drops and folders open the batch optimiser.'),
  batchModeFileCountThreshold: int(30, 'Drops with more files than this use batch mode.'),
  workdir: str(paths => portablePath(path.join(paths.userData, 'work'), paths.home), 'Working directory for backups and temporary files.', { encoding: 'Path; a leading `~` or `$HOME` means the user profile folder. Default `~/AppData/Roaming/Clop for Windows/work` (`%APPDATA%\\Clop for Windows\\work`).' }),
  workdirCleanupInterval: oneOf([600, 3600, 43200, 86400, 259200, 604800, 2592000, 0], 259200, 'Delete working directory files older than this many seconds; 0 never deletes. macOS: `CleanupInterval`.', { encoding: 'Seconds, the CleanupInterval raw value.' }),
  formatsToConvertToJPEG: formats(['webp', 'avif', 'heic', 'bmp'], 'Image formats converted to JPEG before optimising.'),
  formatsToConvertToPNG: formats(['tiff'], 'Image formats converted to PNG before optimising.'),
  formatsToConvertToMP4: formats(['mov', 'm2v', 'mpg', 'webm'], 'Video formats converted to MP4 before optimising.'),
  formatsToConvertToOutputAudio: formats(['wav', 'aiff', 'flac'], 'Audio formats converted to the chosen audio format.'),
  formatsToConvertToAAC: formats(['aiff', 'flac'], 'Audio formats converted to AAC (M4A).'),
  formatsToConvertToMP3: formats(['wav'], 'Audio formats converted to MP3.'),
  convertedImageBehaviour: behaviour('sameFolder', 'Where automatically converted images are saved.'),
  convertedVideoBehaviour: behaviour('inPlace', 'Where automatically converted videos are saved.'),
  optimisedImageBehaviour: behaviour('inPlace', 'Where optimised images are saved.'),
  optimisedVideoBehaviour: behaviour('inPlace', 'Where optimised videos are saved.'),
  optimisedPDFBehaviour: behaviour('inPlace', 'Where optimised PDFs are saved.'),
  sameFolderNameTemplateImage: str('%f-optimised', 'Name template for optimised images saved next to the original.'),
  sameFolderNameTemplateVideo: str('%f-optimised', 'Name template for optimised videos saved next to the original.'),
  sameFolderNameTemplatePDF: str('%f-optimised', 'Name template for optimised PDFs saved next to the original.'),
  specificFolderNameTemplateImage: str('%P/optimised/%f', 'Path template for optimised images saved in a specific folder.'),
  specificFolderNameTemplateVideo: str('%P/optimised/%f', 'Path template for optimised videos saved in a specific folder.'),
  specificFolderNameTemplatePDF: str('%P/optimised/%f', 'Path template for optimised PDFs saved in a specific folder.'),
  optimisedFileProtectionMs: int(3000, 'Milliseconds during which a just-optimised file is not optimised again.'),
  capVideoFPS: bool(true, 'Cap video frame rate.'),
  targetVideoFPS: num(60, 'Frame rate cap for videos. macOS: `Float`.'),
  minVideoFPS: num(30, 'Never cap videos below this frame rate. macOS: `Float`.'),
  playbackSpeedFrameBehaviour: oneOf(['keepFrames', 'dropFrames'], 'keepFrames', 'Whether a speed change keeps every frame or drops frames. macOS: `PlaybackSpeedFrameBehaviour`.'),
  removeAudioFromVideos: bool(false, 'Remove the audio track from optimised videos.'),
  convertAudioToAAC: bool(false, 'Re-encode a video\'s audio track to AAC.'),
  videoEncoder,
  useCPUIntensiveEncoder: bool(false, 'Apple Silicon only: use the software encoder instead of VideoToolbox.', UNSUPPORTED),
  useAggressiveOptimisationMP4: bool(false, 'Legacy aggressive video flag, superseded by `videoCompression`.'),
  useAggressiveOptimisationJPEG: bool(false, 'Legacy aggressive JPEG flag, superseded by `imageCompression`.'),
  useAggressiveOptimisationPNG: bool(false, 'Legacy aggressive PNG flag, superseded by `imageCompression`.'),
  useAggressiveOptimisationGIF: bool(false, 'Legacy aggressive GIF flag, superseded by `imageCompression`.'),
  gifFrameDropBehaviour: oneOf(['playFaster', 'keepDuration'], 'playFaster', 'What happens to GIF timing when high compression drops frames. macOS: `GIFFrameDropBehaviour`.'),
  convertHDRToSDR: bool(false, 'Tone map HDR images to SDR when processing them.'),
  imageCompression: compression({ tier: 'custom', factor: NORMAL }, 'Image compression: tier plus factor (30 normal, 64 aggressive). Legacy Windows key: `defaultMode` (balanced 30, aggressive 64, lossless tier `lossless`).', { encoding: 'Windows also accepts tier `lossless` for images: the true-lossless mode of the original Windows app, which changes no pixels. macOS has no lossless image tier; its image optimisers use only the factor.' }),
  audioCompression: compression({ tier: 'custom', factor: 35 }, 'Audio compression factor; 35 matches 192 kbps AAC.'),
  videoCompression: compression({ tier: 'fast', factor: 50 }, 'Video compression: `fast` uses the hardware encoder, `smaller` a software encoder at the factor\'s CRF, `lossless` CRF 17.'),
  compressionModelMigratedVersion: int(0, 'macOS migration guard for the unified compression keys.', UNSUPPORTED),
  pdfDPI: spec('integer', 0, 'PDF image DPI: 0 picks one per PDF, otherwise 48–300 (PDF_DPI_MIN to PDF_DPI_MAX).', v => v === 0 || (Number.isInteger(v) && (v as number) >= 48 && (v as number) <= 300) ? v as number : undefined, { min: 0, max: 300 }),
  imageDirs: list(paths => [portablePath(paths.desktop, paths.home)], 'Folders watched for new images.', DIRS),
  videoDirs: list(paths => [portablePath(paths.desktop, paths.home)], 'Folders watched for new videos.', DIRS),
  pdfDirs: list([], 'Folders watched for new PDFs.', DIRS),
  audioDirs: list([], 'Folders watched for new audio files.', DIRS),
  dirsHideFloatingResult: list([], 'Watched folders whose results do not show a floating card. macOS: `Set<String>`.', { ...DIRS, unique: true }),
  enableAutomaticImageOptimisations: bool(true, 'Optimise images in watched folders.'),
  enableAutomaticVideoOptimisations: bool(true, 'Optimise videos in watched folders.'),
  enableAutomaticPDFOptimisations: bool(true, 'Optimise PDFs in watched folders.'),
  enableAutomaticAudioOptimisations: bool(false, 'Optimise audio files in watched folders.'),
  editorAppImage: str('', 'App used by "Edit with" for images.', EXE),
  editorAppVideo: str('', 'App used by "Edit with" for videos.', EXE),
  editorAppPDF: str('', 'App used by "Edit with" for PDFs.', EXE),
  editorAppAudio: str('', 'App used by "Edit with" for audio.', EXE),
  audioFormat: oneOf(['sameAsInput', 'aac', 'mp3', 'opus', 'wav', 'flac', 'aiff'], 'aac', 'Output format for optimised audio. macOS: `AudioFormat`.'),
  audioCoverArt: oneOf(['optimise', 'remove', 'keep'], 'optimise', 'What happens to embedded cover art. macOS: `AudioCoverArtBehaviour`.'),
  audioBitrate: int(192, 'Legacy audio bitrate in kbps; -1 and -2 mean one or two steps below the input. Superseded by `audioCompression`.', { min: -2 }),
  optimisedAudioBehaviour: behaviour('inPlace', 'Where optimised audio files are saved.'),
  sameFolderNameTemplateAudio: str('', 'Name template for optimised audio saved next to the original.'),
  specificFolderNameTemplateAudio: str('', 'Path template for optimised audio saved in a specific folder.'),
  convertedAudioBehaviour: behaviour('inPlace', 'Where automatically converted audio files are saved.'),
  manualConvertedImageBehaviour: behaviour('sameFolder', 'Where images converted from a result card are saved.'),
  manualConvertedVideoBehaviour: behaviour('sameFolder', 'Where videos converted from a result card are saved.'),
  manualConvertedAudioBehaviour: behaviour('sameFolder', 'Where audio converted from a result card is saved.'),
  convertedSameFolderNameTemplateImage: str('%f', 'Name template for converted images saved next to the original.'),
  convertedSameFolderNameTemplateVideo: str('%f', 'Name template for converted videos saved next to the original.'),
  convertedSameFolderNameTemplateAudio: str('%f', 'Name template for converted audio saved next to the original.'),
  convertedSpecificFolderNameTemplateImage: str('%P/converted/%f', 'Path template for converted images saved in a specific folder.'),
  convertedSpecificFolderNameTemplateVideo: str('%P/converted/%f', 'Path template for converted videos saved in a specific folder.'),
  convertedSpecificFolderNameTemplateAudio: str('%P/converted/%f', 'Path template for converted audio saved in a specific folder.'),
  maxVideoSizeMB: int(500, 'Skip automatic optimisation of videos larger than this.'),
  maxImageSizeMB: int(50, 'Skip automatic optimisation of images larger than this.'),
  maxPDFSizeMB: int(100, 'Skip automatic optimisation of PDFs larger than this.'),
  maxAudioSizeMB: int(100, 'Skip automatic optimisation of audio files larger than this.'),
  minVideoSizeKB: int(200, 'Skip automatic optimisation of videos smaller than this.'),
  minImageSizeKB: int(50, 'Skip automatic optimisation of images smaller than this.'),
  minPDFSizeKB: int(0, 'Skip automatic optimisation of PDFs smaller than this.'),
  minAudioSizeKB: int(0, 'Skip automatic optimisation of audio files smaller than this.'),
  minImageResolution: int(20, 'Skip images whose width or height is below this many pixels.'),
  minVideoResolution: int(50, 'Skip videos whose width or height is below this many pixels.'),
  maxImageResolution: int(0, 'Skip images whose width or height is above this many pixels; 0 means no limit.'),
  maxVideoResolution: int(0, 'Skip videos whose width or height is above this many pixels; 0 means no limit.'),
  maxVideoFileCount: int(1, 'Skip automatic optimisation when more videos than this are copied or moved at once.'),
  maxImageFileCount: int(4, 'Skip automatic optimisation when more images than this are copied or moved at once.'),
  maxPDFFileCount: int(2, 'Skip automatic optimisation when more PDFs than this are copied or moved at once.'),
  maxAudioFileCount: int(2, 'Skip automatic optimisation when more audio files than this are copied or moved at once.'),
  imageFormatsToSkip: formats(['tiff'], 'Image formats never optimised automatically.'),
  videoFormatsToSkip: formats(['mkv', 'm4v'], 'Video formats never optimised automatically.'),
  audioFormatsToSkip: formats([], 'Audio formats never optimised automatically.'),
  adaptiveVideoSize: bool(true, 'Pick video compression per file.'),
  adaptiveImageSize: bool(false, 'Legacy adaptive image flag, superseded by the `adaptive` tier of `imageCompression`.'),
  downscaleRetinaImages: bool(false, 'Downscale HiDPI screenshots to 1x. Commented out in Settings.swift; kept so imported settings and the key list match macOS.', UNSUPPORTED),
  appendClipboardResults: bool(false, 'Keep each clipboard result instead of replacing the previous one.'),
  copyConsecutiveClipboardImages: bool(true, 'Accumulate consecutive optimised clipboard images into one file list.'),
  clipboardAccumulationTimeout: int(30, 'Seconds consecutive copies keep accumulating.'),
  copyImageFilePath: bool(true, 'Also copy the file path when copying optimised image data.'),
  enablePhotosIntegration: bool(true, 'Optimise images copied from Photos.app.', UNSUPPORTED),
  maxCopiedPhotosCount: int(5, 'Most images copied from Photos.app at once.', UNSUPPORTED),
  maxPhotosLength: spec<number | null>('integer', null, 'Downscale images from Photos.app to this longest edge; null keeps the size. macOS: `Int?`.', v => v === null || (Number.isInteger(v) && (v as number) > 0) ? v as number | null : undefined, { min: 1, ...UNSUPPORTED }),
  photoCropOrientation: oneOf(['landscape', 'portrait', 'adaptive'], 'adaptive', 'Crop orientation for images from Photos.app. macOS: `CropOrientation`.', UNSUPPORTED),
  useCustomNameTemplateForClipboardImages: bool(false, 'Name clipboard images with `customNameTemplateForClipboardImages`.'),
  customNameTemplateForClipboardImages: str('', 'Name template for images saved from the clipboard.'),
  lastAutoIncrementingNumber: int(0, 'Counter behind the `%i` name template token.'),
  floatingResultActions: actions(['downscale', 'restoreOptimise', 'compression', 'aggressiveOptimisation', 'share', 'sendSecurely'], 'Buttons on a floating result.'),
  compactResultActions: actions(['downscale', 'compression', 'crop', 'quickLook', 'restoreOptimise', 'showInFinder', 'saveAs', 'copyToClipboard', 'share'], 'Side buttons on a compact result.'),
  formatPickerStyle: oneOf(['bar', 'extensionHover'], 'bar', 'How a floating result changes format: a format bar or the extension chip. macOS: `FormatPickerStyle`.'),
  mcpEnabled: bool(false, 'Let agents change things through the MCP server. Never writable through MCP itself.'),
  mcpAllowScriptSteps: bool(false, 'Let agents write pipelines that contain script steps.'),
  showCopyClearButtons: bool(true, 'Show the Copy all and Clear all buttons under the results.'),
  enableDragAndDrop: bool(true, 'Show the drop zone while dragging files. Legacy Windows key: `explorerDrag`.'),
  onlyShowDropZoneOnOption: bool(false, 'Show the drop zone only after pressing the modifier key while dragging.'),
  onlyShowPresetZonesOnControlTapped: bool(false, 'Show preset zones only by holding or tapping Control.'),
  showCompactImages: bool(false, 'Show thumbnails in compact results.'),
  autoHideFloatingResults: bool(true, 'Hide floating results automatically.'),
  autoHideFloatingResultsAfter: int(30, 'Seconds before a file result hides.'),
  autoHideClipboardResultAfter: int(10, 'Seconds before a clipboard result hides.'),
  autoClearAllCompactResultsAfter: int(120, 'Seconds before every compact result is cleared.'),
  floatingResultsCorner: oneOf(['bottomRight', 'bottomLeft', 'topRight', 'topLeft'], 'bottomRight', 'Screen corner for floating results. Legacy Windows key: `corner`. macOS: `ScreenCorner`.', { encoding: 'Case name, as the macOS MCP bridge prints it.' }),
  followCursorScreen: bool(true, 'Move results to the screen the cursor stays on.'),
  neverShowProError: bool(false, 'Suppress the Pro licence prompt.', UNSUPPORTED),
  dismissFloatingResultOnDrop: bool(true, 'Dismiss a floating result after dragging it out.'),
  dismissFloatingResultOnUpload: bool(true, 'Dismiss a floating result after uploading it.'),
  dismissCompactResultOnDrop: bool(false, 'Dismiss a compact result after dragging it out.'),
  dismissCompactResultOnUpload: bool(false, 'Dismiss a compact result after uploading it.'),
  autoCopyToClipboard: bool(true, 'Copy results of drops and watched folders to the clipboard. Legacy Windows key: `autoCopy`.'),
  cliInstalled: bool(true, 'The `clop` command-line tool is installed.'),
  keyComboModifiers: list(['Control', 'Shift'], 'Modifiers held with an action key for global shortcuts. macOS: `[TriggerKey]`.', { values: KEY_MODIFIERS, unique: true, encoding: 'Electron accelerator modifiers; macOS stores left/right TriggerKeys.' }),
  quickResizeKeys: shortcutKeys([], 'Number keys that downscale the latest result.'),
  enabledKeys: shortcutKeys(['-', '=', 'Backspace', 'Space', 'Z', 'P', 'C', 'A', 'X', 'R', 'K', 'Escape'], 'Action keys with a global shortcut.'),
  savedCropSizes: json<CropSize[]>([...DEFAULT_CROP_SIZES], 'Saved crop sizes. macOS: `[CropSize]`.', v => Array.isArray(v) && v.every(isCropSize)),
  pauseAutomaticOptimisations: bool(false, 'Pause clipboard and watched-folder optimisation.'),
  presetZones: json<unknown[]>([], 'Preset drop zones, each running a pipeline. macOS: `[PresetZone]`.', v => Array.isArray(v) && v.every(isRecord)),
  syncSettingsCloud: bool(true, 'Sync settings through iCloud.', UNSUPPORTED),
  allowClopToAppearInScreenshots: bool(false, 'Let screenshots capture Clop\'s windows.'),

  // Declared in Clop/Automation.swift rather than Settings.swift. Plain JSON until the pipeline model is ported.
  pipelinesToRunOnImage: json<Record<string, unknown[]>>({}, 'Pipelines per watched folder path or `clipboard`, for images. macOS: `[String: [Pipeline]]` (Automation.swift).', isPipelineMap),
  pipelinesToRunOnVideo: json<Record<string, unknown[]>>({}, 'Pipelines per watched folder path or `clipboard`, for videos. macOS: `[String: [Pipeline]]` (Automation.swift).', isPipelineMap),
  pipelinesToRunOnPdf: json<Record<string, unknown[]>>({}, 'Pipelines per watched folder path or `clipboard`, for PDFs. macOS: `[String: [Pipeline]]` (Automation.swift).', isPipelineMap),
  pipelinesToRunOnAudio: json<Record<string, unknown[]>>({}, 'Pipelines per watched folder path or `clipboard`, for audio. macOS: `[String: [Pipeline]]` (Automation.swift).', isPipelineMap),
  savedPipelines: json<unknown[]>([], 'The saved pipeline library. macOS: `[Pipeline]` (Automation.swift).', v => Array.isArray(v) && v.every(isRecord)),

  // Windows only.
  keepDropZoneVisible: bool(false, 'Keep the drop zone visible without dragging. Legacy Windows key: `pinned`.', { windowsOnly: true }),
  floatingResultsAlwaysOnTop: bool(true, 'Keep floating results above other windows. Legacy Windows key: `alwaysOnTop`.', { windowsOnly: true }),
  launchAtLogin: bool(false, 'Start Clop when signing in to Windows. macOS keeps this as a login item, not a setting.', { windowsOnly: true }),
  defaultImageFormat: oneOf(['auto', 'png', 'jpeg', 'webp', 'avif', 'gif'], 'auto', 'Format for new image results; `auto` keeps the original format. Legacy Windows key: `defaultFormat`.', { windowsOnly: true }),
} satisfies Record<string, SettingSpec<any>>;

export type SettingKey = keyof typeof settingsSchema;
export type ClopSettings = { [K in SettingKey]: (typeof settingsSchema)[K] extends SettingSpec<infer T> ? T : never };
export const SETTING_KEYS = Object.keys(settingsSchema) as SettingKey[];

export function defaultSettings(paths: Partial<DefaultPaths> = {}): ClopSettings {
  const resolved = { ...defaultPaths(), ...paths };
  return Object.fromEntries(SETTING_KEYS.map(key => {
    const value: unknown = settingsSchema[key].default;
    return [key, structuredClone(typeof value === 'function' ? value(resolved) : value)];
  })) as ClopSettings;
}

/** Applies every recognised, valid key of `value` on top of `current`. Unknown keys and invalid values are ignored. */
export function parseSettings(value: unknown, current: ClopSettings = defaultSettings()): ClopSettings {
  const next: Record<string, unknown> = { ...current };
  if (!isRecord(value)) return next as ClopSettings;
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(settingsSchema, key)) continue;
    const parsed = (settingsSchema[key as SettingKey] as SettingSpec).parse(raw);
    if (parsed !== undefined) next[key] = parsed;
  }
  return next as ClopSettings;
}

// The settings shape of the Windows app before this schema (`electron/settings.ts` up to v0.1.1),
// and the schema key each field moved to.
export const LEGACY_KEYS = {
  clipboard: 'enableClipboardOptimiser', autoCopy: 'autoCopyToClipboard', explorerDrag: 'enableDragAndDrop',
  pinned: 'keepDropZoneVisible', alwaysOnTop: 'floatingResultsAlwaysOnTop', launchAtLogin: 'launchAtLogin',
  corner: 'floatingResultsCorner', defaultMode: 'imageCompression', defaultFormat: 'defaultImageFormat',
} as const satisfies Record<string, SettingKey>;
const LEGACY_CORNERS = new Map(Object.entries({ 'bottom-right': 'bottomRight', 'bottom-left': 'bottomLeft', 'top-right': 'topRight', 'top-left': 'topLeft' }));
const LEGACY_MODES = new Map<string, CompressionQuality>([['balanced', { tier: 'custom', factor: NORMAL }], ['aggressive', { tier: 'custom', factor: AGGRESSIVE }], ['lossless', { tier: 'lossless', factor: NORMAL }]]);

/** A legacy file carries keys that no longer exist in the schema. */
export function isLegacySettings(value: unknown): boolean {
  return isRecord(value) && Object.keys(LEGACY_KEYS).some(key => Object.hasOwn(value, key) && !Object.hasOwn(settingsSchema, key));
}

export function migrateLegacy(value: unknown, paths: Partial<DefaultPaths> = {}): ClopSettings {
  if (!isRecord(value)) return defaultSettings(paths);
  const convert: Record<string, (value: unknown) => unknown> = { corner: v => LEGACY_CORNERS.get(String(v)), defaultMode: v => LEGACY_MODES.get(String(v)) };
  const mapped: Record<string, unknown> = {};
  for (const [legacy, key] of Object.entries(LEGACY_KEYS)) if (Object.hasOwn(value, legacy)) mapped[key] = Object.hasOwn(convert, legacy) ? convert[legacy](value[legacy]) : value[legacy];
  return parseSettings(mapped, defaultSettings(paths));
}
