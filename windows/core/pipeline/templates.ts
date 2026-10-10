import type { ClopFileType } from './model';

// Port of ALL_STEP_TEMPLATES and TEMPLATE_VARIABLES (Clop/Automation.swift): the step catalogue the editor
// autocompletes from and the parser validates against. Names are the text names (`if`, not `filterIf`).

export type StepCategory = 'processing' | 'fileOperation' | 'filter' | 'mediaSpecific' | 'action';
export interface ParamTemplate {
  name: string;
  description: string;
  suggestions: readonly string[];
  /** False when only the suggestions are accepted. */
  freeText: boolean;
  needsQuotes?: boolean;
  valueDescriptions?: Readonly<Record<string, string>>;
  valueDescriptionsForType?: Partial<Record<ClopFileType, Readonly<Record<string, string>>>>;
  suggestionsForType?: Partial<Record<ClopFileType, readonly string[]>>;
  /** Unset means every file type. */
  applicableTypes?: readonly ClopFileType[];
}
export interface StepTemplate {
  name: string;
  description: string;
  category: StepCategory;
  mandatoryParams: readonly ParamTemplate[];
  optionalParams: readonly ParamTemplate[];
  applicableTypes: readonly ClopFileType[];
}

const ALL: readonly ClopFileType[] = ['image', 'video', 'audio', 'pdf'];
const LOCATION_HELP = { inPlace: 'replace original file', sameFolder: 'save next to original', temporaryFolder: 'save in temp directory', template: 'custom path with %f (filename), %y (year), etc. Output extension is added automatically' };
const location = (suggestions = ['inPlace', 'sameFolder', 'temporaryFolder', 'template'], description = 'where to save the result', valueDescriptions: Record<string, string> = LOCATION_HELP): ParamTemplate =>
  ({ name: 'location', description, suggestions, freeText: true, valueDescriptions });
const param = (name: string, description: string, extra: Partial<ParamTemplate> = {}): ParamTemplate => ({ name, description, suggestions: [], freeText: true, ...extra });
const quoted = (name: string, description: string, extra: Partial<ParamTemplate> = {}) => param(name, description, { needsQuotes: true, ...extra });
const step = (name: string, description: string, category: StepCategory, applicableTypes: readonly ClopFileType[], mandatoryParams: ParamTemplate[] = [], optionalParams: ParamTemplate[] = []): StepTemplate =>
  ({ name, description, category, mandatoryParams, optionalParams, applicableTypes });

export const SHELVE_WITH_APPS: Readonly<Record<string, string>> = { yoink: 'Yoink shelf app', dockside: 'Dockside shelf app', dropover: 'Dropover shelf app', atoll: 'Atoll shelf app' };
export const UPLOAD_WITH_APPS: Readonly<Record<string, string>> = { dropshare: 'Dropshare file upload service' };

export const STEP_TEMPLATES: readonly StepTemplate[] = [
  step('optimise', 'Optimise file size', 'processing', ALL, [], [
    param('encoder', 'compression quality preset', {
      suggestions: ['aggressive', 'medium', 'lossless'], freeText: false,
      valueDescriptions: { aggressive: 'smallest file size', medium: 'balanced quality/size', lossless: 'no quality loss' },
      valueDescriptionsForType: {
        video: { fast: 'hardware encoder, quick and battery efficient', slowHighQuality: 'slow software encoder, smaller files', visuallyLossless: 'no perceptible quality loss (CRF 17)' },
        pdf: { aggressive: 'lossy + downsample images to 100 DPI', medium: 'adaptive downsampling, picks DPI per PDF based on embedded image resolutions', lossless: 'no downsampling, preserves embedded image resolution' },
      },
      suggestionsForType: { video: ['fast', 'slowHighQuality', 'visuallyLossless'] },
    }),
    param('compression', 'how hard to compress, 5 (best quality) to 100 (smallest file)', { suggestions: ['30', '50', '64', '75', '90', 'adaptive'], valueDescriptions: { 30: "Clop's normal setting", 64: 'aggressive', adaptive: 'let Clop pick per file' } }),
    param('adaptive', 'auto-pick best format', { suggestions: ['true', 'false'], freeText: false, valueDescriptions: { true: 'may change file extension', false: 'keep original format' }, applicableTypes: ['image'] }),
    param('dpi', 'PDF only: image resolution, overrides encoder choice (300 = no downsampling)', {
      suggestions: ['300', '250', '200', '150', '100', '72', '48'], applicableTypes: ['pdf'],
      valueDescriptions: { 300: 'no downsampling, preserves embedded image resolution', 250: 'lightly downsample, near print quality', 200: 'lightly downsample, good for screen reading', 150: 'downsample for screen reading', 100: 'smaller, readable but visibly degraded', 72: 'screen quality', 48: 'smallest, very low quality' },
    }),
    location(),
  ]),
  step('downscale', 'Scale down by a factor, always keeps aspect ratio (lowers audio bitrate for audio files)', 'processing', ['image', 'video', 'audio'],
    [param('factor', '0.0 to 1.0 (e.g. 0.5 = half size, 0.75 = 75%)', { suggestions: ['0.5', '0.75', '0.25'] })], [location()]),
  step('lowerBitrate', 'Lower the audio bitrate (never upscales, snaps to allowed bitrates)', 'processing', ['audio'],
    [param('kbps', 'target bitrate in kbps', { suggestions: ['192', '160', '128', '96', '64'] })], [location()]),
  step('convert', 'Convert to a different format', 'processing', ['image', 'video', 'audio'], [
    param('to', 'target format extension', {
      suggestions: ['webp', 'avif', 'heic', 'jxl', 'jpeg', 'png', 'gif', 'mp4', 'webm', 'm4a', 'mp3', 'ogg', 'flac'],
      valueDescriptions: {
        webp: 'WebP image format', avif: 'AV1 image format', heic: 'HEIC image format', jxl: 'JPEG XL image format', jpeg: 'JPEG image format', png: 'PNG image format', gif: 'animated GIF',
        webm: 'WebM video (VP9)', hevc: 'MP4 encoded with HEVC/H.265 hardware encoder (fast, battery efficient)', x265: 'MP4 encoded with x265 software encoder (better compression, but slower)', av1: 'AV1 video (libsvtav1)', mp4: 'MP4 video (H.264)',
        m4a: 'AAC audio', mp3: 'MP3 audio', ogg: 'Ogg Vorbis audio', flac: 'FLAC lossless audio', wav: 'WAV uncompressed audio', aiff: 'AIFF uncompressed audio',
      },
      suggestionsForType: { image: ['webp', 'avif', 'heic', 'jxl', 'jpeg', 'png', 'gif'], video: ['gif', 'webm', 'hevc', 'x265', 'av1'], audio: ['m4a', 'mp3', 'ogg', 'flac', 'wav', 'aiff'] },
    }),
  ], [location(['sameFolder', 'inPlace', 'temporaryFolder', 'template'])]),
  step('crop', 'Resize to exact pixel dimensions', 'processing', ['image', 'video'], [
    param('width', 'max width in pixels, height is computed if not set', { suggestions: ['1920', '1600', '1280', '1024', '96'] }),
  ], [
    param('height', 'max height in pixels, width is computed if not set', { suggestions: ['1080', '900', '720', '1024', '96'] }),
    param('longEdge', 'target size for longest dimension (use instead of width/height)', { suggestions: ['1920', '1600', '1280', '1024', '512'] }),
    param('aspectRatio', 'crop to a shape instead of pixel dimensions (use instead of width/height)', { suggestions: ['16:9', '4:3', '3:2', '1:1', '9:16'], valueDescriptions: { '16:9': 'widescreen', '4:3': 'classic', '3:2': '35mm photo', '1:1': 'square', '9:16': 'vertical video' } }),
    param('smartCrop', 'keep the most interesting part of the frame instead of the centre', { suggestions: ['true', 'false'], freeText: false }),
    location(),
  ]),
  step('extractPagesAsImages', 'Extract PDF pages as images', 'processing', ['pdf'], [], [
    param('format', 'image format for extracted pages', { suggestions: ['jpeg', 'png'], freeText: false, valueDescriptions: { jpeg: 'JPEG (smaller, white background)', png: 'PNG (transparency preserved)' } }),
    param('quality', 'render resolution', { suggestions: ['low', 'medium', 'high'], freeText: false, valueDescriptions: { low: '1x scale (72 DPI)', medium: '2x scale (144 DPI)', high: '3x scale (216 DPI)' } }),
    location(['sameFolder', 'temporaryFolder', 'template'], 'where to save extracted images', { sameFolder: 'save next to original PDF', temporaryFolder: 'save in temp directory', template: 'custom path with %f (filename), %y (year), etc.' }),
  ]),
  step('targetSize', 'Compress until the file fits under a size limit (Discord 10MB, email 25MB, etc.)', 'processing', ALL, [
    param('size', 'size limit, e.g. 10MB, 500KB', {
      suggestions: ['240KB', '1MB', '5MB', '8MB', '10MB', '16MB', '25MB'],
      valueDescriptions: { '240KB': 'US visa photo limit', '5MB': 'Notion free plan', '8MB': 'Google Play screenshots', '10MB': 'Discord free, GitHub attachments', '16MB': 'WhatsApp media', '25MB': 'Gmail attachments' },
    }),
  ], [location()]),
  step('stripExif', 'Remove EXIF and GPS metadata (privacy before sharing)', 'processing', ['image', 'video']),
  step('watermark', 'Overlay a watermark image', 'processing', ['image', 'video'], [
    quoted('image', 'path to the watermark image (PNG with transparency works best)'),
  ], [
    param('position', 'corner or center placement', { suggestions: ['bottomRight', 'bottomLeft', 'topRight', 'topLeft', 'center'], freeText: false }),
    param('opacity', '0.0 to 1.0', { suggestions: ['1.0', '0.5', '0.3'] }),
    param('scale', 'watermark width as a fraction of the file width', { suggestions: ['0.15', '0.1', '0.25', '0.5'] }),
    location(),
  ]),
  step('capFps', 'Cap the video frame rate', 'mediaSpecific', ['video'], [param('fps', 'maximum frames per second', { suggestions: ['60', '30', '24', '15', '10'] })]),
  step('normalize', 'Normalize audio loudness', 'mediaSpecific', ['audio'], [], [
    param('lufs', 'target integrated loudness', { suggestions: ['-14', '-16', '-23'], valueDescriptions: { '-14': 'Spotify / YouTube', '-16': 'Apple Podcasts', '-23': 'EBU broadcast' } }),
  ]),
  step('copy', 'Copy file to a path', 'fileOperation', ALL, [quoted('to', 'destination path, supports sourceFolder, sourceFileName, $1, $2')]),
  step('move', 'Move file to a path', 'fileOperation', ALL, [quoted('to', 'destination path, supports sourceFolder, sourceFileName, $1, $2')]),
  step('rename', 'Rename the file', 'fileOperation', ALL, [quoted('to', 'new name, supports sourceFileName, $1, $2')]),
  step('delete', 'Delete a file', 'fileOperation', ALL, [quoted('path', 'path to delete, supports %P, %f, %e and other template tokens')]),
  step('if', 'Continue pipeline only if condition matches', 'filter', ALL, [], [
    quoted('regex', 'pattern matched against filename (smart case), capture groups as $1, $2'),
    param('types', 'space-separated file types or extensions: jpeg png webp heic'),
    quoted('nameContains', 'case-insensitive substring match'),
    quoted('nameIs', 'exact filename match'),
    param('fileSizeGreaterThan', 'min file size in bytes'),
    param('fileSizeLowerThan', 'max file size in bytes'),
    param('widthGreaterThan', 'min width in pixels', { applicableTypes: ['image'] }),
    param('widthLowerThan', 'max width in pixels', { applicableTypes: ['image'] }),
    param('heightGreaterThan', 'min height in pixels', { applicableTypes: ['image'] }),
    param('heightLowerThan', 'max height in pixels', { applicableTypes: ['image'] }),
    param('dpiGreaterThan', 'min DPI (images & PDFs)', { suggestions: ['72', '150', '300'], applicableTypes: ['image', 'pdf'] }),
    param('dpiLowerThan', 'max DPI (images & PDFs)', { suggestions: ['72', '150', '300'], applicableTypes: ['image', 'pdf'] }),
    param('minFileSize', 'minimum file size, e.g. 100kb or 2mb', { suggestions: ['100kb', '1mb'] }),
    param('minResolution', 'minimum width & height in pixels, e.g. 100x100', { suggestions: ['100x100', '640x480'], applicableTypes: ['image'] }),
    quoted('copiedBy', 'app that copied the item (clipboard only), fuzzy match on app name or executable'),
  ]),
  step('ifNot', 'Continue pipeline only if condition does NOT match', 'filter', ALL, [], [
    quoted('regex', 'pattern matched against filename (smart case)'),
    param('types', 'space-separated file types or extensions to exclude'),
    quoted('nameContains', 'case-insensitive substring to exclude'),
    quoted('nameIs', 'exact filename to exclude'),
    quoted('copiedBy', 'exclude when copied by this app (clipboard only), fuzzy match on app name or executable'),
  ]),
  step('removeAudio', 'Strip the audio track', 'mediaSpecific', ['video']),
  step('changeSpeed', 'Change playback speed', 'mediaSpecific', ['video', 'audio'],
    [param('factor', 'speed multiplier (e.g. 2.0 = 2x, 0.5 = half speed)', { suggestions: ['1.5', '2.0', '0.5', '0.75'] })],
    [param('frames', 'keep (smoother, higher fps) or drop (smaller file). Unset follows Settings > Video', { suggestions: ['keep', 'drop'], freeText: false, applicableTypes: ['video'] })]),
  step('runScript', 'Run a script file, executable, or inline PowerShell code. The input file is passed as the first argument and in CLOP_INPUT_FILE; Clop\'s bundled tools (ffmpeg, gs, gifski…) are in CLOP_BIN; print a file path to stdout to swap the file the pipeline carries forward', 'action', ALL, [], [
    quoted('path', 'path to a script file or executable'),
    quoted('code', 'inline PowerShell code (use instead of path)'),
  ]),
  step('runShortcut', 'Run a macOS Shortcut (kept so macOS pipelines load; use runScript on Windows)', 'action', ['image', 'video', 'pdf'], [quoted('name', 'shortcut name as shown in Shortcuts.app')]),
  step('copyToClipboard', 'Copy file reference to clipboard', 'action', ALL, [], [
    param('format', 'clipboard content format', {
      suggestions: ['path', 'imageData', 'markdown'], freeText: false,
      valueDescriptions: { path: 'file path, relative if relativeTo is set', imageData: 'raw image data', markdown: 'markdown link, relative if relativeTo is set' },
      suggestionsForType: { video: ['path', 'markdown'], audio: ['path', 'markdown'], pdf: ['path', 'markdown'] },
    }),
    quoted('relativeTo', 'base path, makes output relative (e.g. ~/Projects/blog)'),
  ]),
  step('copyLinkForSending', 'Send file securely and copy share link to clipboard', 'action', ALL, [], [
    param('expiration', 'auto-stop the link after this long (1m–3d, or never). Defaults to the setting in Preferences', { suggestions: ['1m', '15m', '1h', '6h', '1d', '3d', 'never'] }),
  ]),
  step('fork', 'Also show the result so far as a second draggable card, then keep processing', 'action', ALL, [], [
    param('location', 'where to save the forked card\'s file (defaults to a temp file you can drag out)', { suggestions: ['sameFolder', 'temporaryFolder'] }),
  ]),
  step('shelveWith', 'Send file to a shelf app', 'action', ALL, [param('app', 'shelf app to send to', { suggestions: Object.keys(SHELVE_WITH_APPS), freeText: false, valueDescriptions: SHELVE_WITH_APPS })]),
  step('uploadWith', 'Upload file via an upload app', 'action', ALL, [param('app', 'upload app to use', { suggestions: Object.keys(UPLOAD_WITH_APPS), freeText: false, valueDescriptions: UPLOAD_WITH_APPS })]),
  step('openWith', 'Open file with a specific app', 'action', ALL, [param('app', 'application name or path to an .exe (e.g. Paint, Photoshop)')]),
];

const BY_NAME = new Map(STEP_TEMPLATES.map(template => [template.name, template]));
export const stepTemplate = (name: string): StepTemplate | undefined => BY_NAME.get(name);
/** `stepTemplates(for:)`: the steps that apply to a file type, or all of them. */
export const stepTemplates = (fileType?: ClopFileType) => fileType ? STEP_TEMPLATES.filter(template => template.applicableTypes.includes(fileType)) : STEP_TEMPLATES;
export const stepParams = (template: StepTemplate) => [...template.mandatoryParams, ...template.optionalParams];
export const paramApplies = (param: ParamTemplate, fileType?: ClopFileType) => !param.applicableTypes || !fileType || param.applicableTypes.includes(fileType);
export const paramSuggestions = (param: ParamTemplate, fileType?: ClopFileType) => (fileType && param.suggestionsForType?.[fileType]) || param.suggestions;
export const paramValueDescriptions = (param: ParamTemplate, fileType?: ClopFileType) => (fileType && param.valueDescriptionsForType?.[fileType]) || param.valueDescriptions || {};

export interface TemplateVariable { token: string; name: string; description: string }
export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { token: '%f', name: 'filename', description: 'source file name without extension' },
  { token: '%e', name: 'extension', description: 'source file extension without dot (note: output extension is always added automatically)' },
  { token: '%P', name: 'path', description: 'source file directory path' },
  { token: '%F', name: 'fullPath', description: 'full source file path including filename' },
  { token: '%y', name: 'year', description: 'current year (e.g. 2026)' },
  { token: '%m', name: 'month', description: 'month number (01-12)' },
  { token: '%n', name: 'monthName', description: 'month name (e.g. March)' },
  { token: '%d', name: 'day', description: 'day of month (01-31)' },
  { token: '%w', name: 'weekday', description: 'day of week (e.g. Friday)' },
  { token: '%H', name: 'hour', description: 'hour (00-23)' },
  { token: '%M', name: 'minutes', description: 'minutes (00-59)' },
  { token: '%S', name: 'seconds', description: 'seconds (00-59)' },
  { token: '%p', name: 'amPm', description: 'AM or PM' },
  { token: '%r', name: 'random', description: 'random characters' },
  { token: '%i', name: 'counter', description: 'auto-incrementing number' },
];
