import type { CompressionQuality } from '../settings/schema';
import { stepTemplate, stepParams } from './templates';

// The pipeline model from Clop/Pipeline.swift and Clop/PipelineStep.swift. A step is stored exactly as Swift's synthesised
// Codable writes the enum: `{ "<case>": { <labelled values> } }`, unlabelled values under `_0`, cases without values as
// `{}`, nil optionals left out. The text DSL calls the filter cases `if`/`ifNot`; JSON calls them `filterIf`/`filterIfNot`.
// Nothing here touches Node, so the renderer can use it for the editor.

export const FILE_TYPES = ['image', 'video', 'audio', 'pdf'] as const;
export type ClopFileType = (typeof FILE_TYPES)[number];
export const ENCODER_QUALITIES = ['aggressive', 'medium', 'lossless'] as const;
export type EncoderQuality = (typeof ENCODER_QUALITIES)[number];
/** `VideoEncoder` (Shared/VideoEncoder.swift). `optimise(encoder: fast)` stores it as `videoEncoder`. */
export const VIDEO_ENCODER_PRESETS = ['fast', 'slowHighQuality', 'visuallyLossless'] as const;
export type VideoEncoderPreset = (typeof VIDEO_ENCODER_PRESETS)[number];
export const CLIPBOARD_FORMATS = ['path', 'imageData', 'markdown'] as const;
export type ClipboardCopyFormat = (typeof CLIPBOARD_FORMATS)[number];
/** `PlaybackSpeedFrameBehaviour`; the DSL spells them `keep` and `drop`. */
export const FRAME_BEHAVIOURS = ['keepFrames', 'dropFrames'] as const;
export type FrameBehaviour = (typeof FRAME_BEHAVIOURS)[number];
export const LOCATION_KEYWORDS = ['inPlace', 'sameFolder', 'temporaryFolder'] as const;
export const PAGE_FORMATS = ['jpeg', 'png'] as const;
export const PAGE_QUALITIES = ['low', 'medium', 'high'] as const;
export const WATERMARK_POSITIONS = ['bottomRight', 'bottomLeft', 'topRight', 'topLeft', 'center'] as const;
export const SHELF_APPS = ['yoink', 'dockside', 'dropover', 'atoll'] as const;
export const UPLOAD_APPS = ['dropshare'] as const;
/** What `convert(to:)` produces per file type: the editor's suggestions plus the aliases the macOS converters accept. */
export const CONVERT_TARGETS: Readonly<Record<Exclude<ClopFileType, 'pdf'>, readonly string[]>> = {
  image: ['webp', 'avif', 'heic', 'jxl', 'jpeg', 'jpg', 'png', 'gif'],
  video: ['mp4', 'mov', 'hevc', 'x265', 'av1', 'webm', 'gif'],
  audio: ['m4a', 'aac', 'mp3', 'ogg', 'opus', 'flac', 'wav', 'aiff'],
};

export interface FilterCondition {
  types?: string[]; regex?: string; nameContains?: string; nameIs?: string;
  fileSizeGreaterThan?: number; fileSizeLowerThan?: number; widthGreaterThan?: number; widthLowerThan?: number;
  heightGreaterThan?: number; heightLowerThan?: number; dpiGreaterThan?: number; dpiLowerThan?: number;
  minFileSize?: number; minResolution?: number; copiedBy?: string;
}
/** Lowtech's `Shortcut`. Windows has no Shortcuts app, so a parsed `runShortcut(name:)` uses the name as the identifier too, as macOS does for an unknown shortcut. */
export interface Shortcut { name: string; identifier: string }

/** Associated values of every `PipelineStep` case, in declaration order. */
export interface StepParamMap {
  optimise: { encoder: EncoderQuality; adaptive: boolean; videoEncoder?: VideoEncoderPreset; dpi?: number; location: string; compression?: CompressionQuality };
  downscale: { factor: number; location: string };
  lowerBitrate: { kbps: number; location: string };
  convert: { to: string; location: string };
  crop: { width?: number; height?: number; longEdge?: number; aspectRatio?: string; smartCrop: boolean; location: string };
  extractPagesAsImages: { format: string; quality: string; location: string };
  targetSize: { bytes: number; location: string };
  stripExif: Record<string, never>;
  watermark: { image: string; position: string; opacity: number; scale: number; location: string };
  copy: { to: string };
  move: { to: string };
  rename: { to: string };
  delete: { path: string };
  filterIf: { _0: FilterCondition };
  filterIfNot: { _0: FilterCondition };
  removeAudio: Record<string, never>;
  changeSpeed: { factor: number; frames?: FrameBehaviour };
  capFps: { fps: number };
  normalize: { lufs: number };
  runScript: { path?: string; code?: string };
  runShortcut: { _0: Shortcut };
  copyToClipboard: { format: ClipboardCopyFormat; relativeTo?: string };
  /** Seconds; 0 means never. */
  copyLinkForSending: { expiration?: number };
  fork: { location?: string };
  shelveWith: { app: string };
  uploadWith: { app: string };
  openWith: { app: string };
}
export type StepKind = keyof StepParamMap;
export type PipelineStep = { [K in StepKind]: { [P in K]: StepParamMap[K] } }[StepKind];
export type StepEntry = { [K in StepKind]: [K, StepParamMap[K]] }[StepKind];

export interface Pipeline {
  id: string;
  /** The stored steps. Primary: `rawText` is only parsed again when this is empty. */
  steps: PipelineStep[];
  name?: string;
  /** The text the user wrote, kept verbatim for display and editing. */
  rawText?: string;
  skipOptimisation: boolean;
  hideResult: boolean;
  /** Set on a reference to a saved pipeline, which then supplies the steps. */
  libraryID?: string;
  fileType?: ClopFileType;
  /** An SF Symbol name on macOS. */
  icon?: string;
  details?: string;
}
export interface PresetZone { id: string; icon: string; name: string; type?: ClopFileType; pipeline: Pipeline }

type FieldType = 'string' | 'int' | 'number' | 'bool' | 'compression' | 'filter' | 'shortcut' | readonly string[];
export interface Field { key: string; type: FieldType; default?: string | number | boolean; required?: true }
const field = (key: string, type: FieldType, extra: Omit<Field, 'key' | 'type'> = {}): Field => ({ key, type, ...extra });
const REQUIRED = { required: true } as const;
const location = (fallback: string) => field('location', 'string', { default: fallback });
const to = [field('to', 'string', REQUIRED)];

/** Each case's values in declaration order, with the defaults the Swift decoder fills in. The order is the JSON key order. */
export const STEP_FIELDS: { readonly [K in StepKind]: readonly Field[] } = {
  optimise: [field('encoder', ENCODER_QUALITIES, { default: 'medium' }), field('adaptive', 'bool', { default: false }), field('videoEncoder', VIDEO_ENCODER_PRESETS), field('dpi', 'int'), location('inPlace'), field('compression', 'compression')],
  downscale: [field('factor', 'number', REQUIRED), location('inPlace')],
  lowerBitrate: [field('kbps', 'int', REQUIRED), location('inPlace')],
  convert: [field('to', 'string', REQUIRED), location('sameFolder')],
  crop: [field('width', 'int'), field('height', 'int'), field('longEdge', 'int'), field('aspectRatio', 'string'), field('smartCrop', 'bool', { default: false }), location('inPlace')],
  extractPagesAsImages: [field('format', 'string', { default: 'jpeg' }), field('quality', 'string', { default: 'medium' }), location('sameFolder')],
  targetSize: [field('bytes', 'int', REQUIRED), location('inPlace')],
  stripExif: [],
  watermark: [field('image', 'string', REQUIRED), field('position', 'string', { default: 'bottomRight' }), field('opacity', 'number', { default: 1 }), field('scale', 'number', { default: 0.15 }), location('inPlace')],
  copy: to,
  move: to,
  rename: to,
  delete: [field('path', 'string', { default: 'sourceFile' })],
  filterIf: [field('_0', 'filter', REQUIRED)],
  filterIfNot: [field('_0', 'filter', REQUIRED)],
  removeAudio: [],
  changeSpeed: [field('factor', 'number', REQUIRED), field('frames', FRAME_BEHAVIOURS)],
  capFps: [field('fps', 'int', REQUIRED)],
  normalize: [field('lufs', 'number', { default: -16 })],
  runScript: [field('path', 'string'), field('code', 'string')],
  runShortcut: [field('_0', 'shortcut', REQUIRED)],
  copyToClipboard: [field('format', CLIPBOARD_FORMATS, { default: 'path' }), field('relativeTo', 'string')],
  copyLinkForSending: [field('expiration', 'number')],
  fork: [field('location', 'string')],
  shelveWith: [field('app', 'string', REQUIRED)],
  uploadWith: [field('app', 'string', REQUIRED)],
  openWith: [field('app', 'string', REQUIRED)],
};
export const STEP_KINDS = Object.keys(STEP_FIELDS) as StepKind[];
export const isStepKind = (value: string): value is StepKind => Object.hasOwn(STEP_FIELDS, value);

export type FilterKey = keyof FilterCondition;
const condition = (key: FilterKey, type: FieldType) => ({ key, type });
/** `FilterCondition` in declaration order. */
export const FILTER_FIELDS = [
  condition('types', 'string'), condition('regex', 'string'), condition('nameContains', 'string'), condition('nameIs', 'string'),
  condition('fileSizeGreaterThan', 'int'), condition('fileSizeLowerThan', 'int'), condition('widthGreaterThan', 'int'), condition('widthLowerThan', 'int'),
  condition('heightGreaterThan', 'int'), condition('heightLowerThan', 'int'), condition('dpiGreaterThan', 'int'), condition('dpiLowerThan', 'int'),
  condition('minFileSize', 'int'), condition('minResolution', 'int'), condition('copiedBy', 'string'),
] as const;

/** The DSL name of a step: the case name, except `if`/`ifNot` for the filters. */
export const textName = (kind: StepKind) => kind === 'filterIf' ? 'if' : kind === 'filterIfNot' ? 'ifNot' : kind;
export const kindForTextName = (name: string): StepKind | undefined => name === 'if' ? 'filterIf' : name === 'ifNot' ? 'filterIfNot' : name === 'filterIf' || name === 'filterIfNot' || !isStepKind(name) ? undefined : name;

export const stepKind = (step: PipelineStep) => Object.keys(step)[0] as StepKind;
export const stepEntry = (step: PipelineStep) => { const kind = stepKind(step); return [kind, (step as Record<string, unknown>)[kind]] as StepEntry; };

/** `known` keys in their order, then any other defined keys: values a newer macOS added are kept so they sync back. */
export function ordered(value: Record<string, unknown>, known: readonly string[], map: (key: string, item: unknown) => unknown = (_, item) => item) {
  const out: Record<string, unknown> = {};
  for (const key of [...known, ...Object.keys(value).filter(key => !known.includes(key))]) if (value[key] !== undefined) out[key] = map(key, value[key]);
  return out;
}
const SHORTCUT_KEYS = ['name', 'identifier'], FILTER_KEYS = () => FILTER_FIELDS.map(({ key }) => key);

/** A step in canonical form: keys in declaration order, defaults filled in, unset optionals dropped, unknown values kept last. */
export function makeStep<K extends StepKind>(kind: K, params: Partial<StepParamMap[K]>): PipelineStep {
  const fields = STEP_FIELDS[kind], values: Record<string, unknown> = { ...params };
  for (const { key, default: fallback } of fields) values[key] ??= fallback;
  const out = ordered(values, fields.map(({ key }) => key), (key, item) => key !== '_0' ? item : ordered(item as Record<string, unknown>, kind === 'runShortcut' ? SHORTCUT_KEYS : FILTER_KEYS()));
  return { [kind]: out } as PipelineStep;
}

/** `CropSize(aspectRatio:)`: `W:H` with optional decimals, scaled to whole numbers (`1.91:1` is 191:100). */
export function parseAspectRatio(text: string): { width: number; height: number } | undefined {
  const sides = text.split(':');
  if (sides.length !== 2) return undefined;
  const scaled = (side: string) => {
    const [, whole, fraction = ''] = /^(\d+)(?:[.,](\d+))?$/.exec(side.trim()) ?? [];
    return whole === undefined ? undefined : { value: Number(whole + fraction), decimals: fraction.length };
  };
  const w = scaled(sides[0]), h = scaled(sides[1]);
  if (!w || !h) return undefined;
  const width = w.value * 10 ** Math.max(0, h.decimals - w.decimals), height = h.value * 10 ** Math.max(0, w.decimals - h.decimals);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

export interface StepProblem { /** The DSL parameter at fault, when there is one. */ param?: string; message: string }
interface NumberRule { integer?: boolean; above?: number; min?: number; max?: number }
function describe({ integer, above, min, max }: NumberRule) {
  const base = integer ? 'a whole number' : 'a number';
  if (min !== undefined && max !== undefined) return `${base} from ${min} to ${max}`;
  const low = above !== undefined ? `above ${above}` : min !== undefined ? `of at least ${min}` : '';
  return [base, low, max !== undefined && `${low ? 'and ' : ''}at most ${max}`].filter(Boolean).join(' ');
}
const breaks = (value: number, rule: NumberRule) => !Number.isFinite(value) || (rule.integer && !Number.isInteger(value)) || (rule.above !== undefined && value <= rule.above) || (rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max);
const POSITIVE_INT: NumberRule = { integer: true, above: 0 }, COUNT: NumberRule = { integer: true, min: 0 };
const FILTER_COUNTS = ['fileSizeGreaterThan', 'fileSizeLowerThan', 'widthGreaterThan', 'widthLowerThan', 'heightGreaterThan', 'heightLowerThan', 'dpiGreaterThan', 'dpiLowerThan', 'minFileSize', 'minResolution'] as const;
/** `a, b or c`, for messages. */
export const orList = (values: readonly string[]) => values.length < 3 ? values.join(' or ') : `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;

/**
 * Values a step can hold structurally but that cannot work on Windows: out-of-range numbers, empty paths, unknown names, a
 * filter without a condition. The text parser refuses them; stored pipelines keep them (see `pipelineProblems`). Regexes
 * are not checked here: macOS writes ICU syntax, which the executor reads.
 */
export const stepProblems = (step: PipelineStep): StepProblem[] => checkStep(step).map(({ problem }) => problem);

/**
 * The problems that make a step unsafe to run at all: a number out of range (`downscale(factor: 0)`), an empty value
 * (`rename(to: "")`), a step missing what it needs. The executor refuses these; unknown names and values are left to it.
 */
export const blockingProblems = (step: PipelineStep): StepProblem[] => checkStep(step).filter(({ blocking }) => blocking).map(({ problem }) => problem);

function checkStep(step: PipelineStep): { problem: StepProblem; blocking: boolean }[] {
  const found: { problem: StepProblem; blocking: boolean }[] = [];
  const problems = { push: (problem: StepProblem, blocking = true) => found.push({ problem, blocking }) };
  const number = (param: string, value: number | undefined, rule: NumberRule, blocking = true) => { if (value !== undefined && breaks(value, rule)) problems.push({ param, message: `${param} must be ${describe(rule)}, got ${value}` }, blocking); };
  const filled = (param: string, value: string | undefined) => { if (value !== undefined && !value.trim()) problems.push({ param, message: `${param} needs a value` }); };
  const oneOf = (param: string, value: string, values: readonly string[]) => { if (!values.includes(value)) problems.push({ param, message: `${param} must be ${orList(values)}, got "${value}"` }, false); };
  const [kind, p] = stepEntry(step);
  if ('location' in p) filled('location', p.location);
  switch (kind) {
    case 'optimise':
      // A stored dpi of 0 means adaptive to the PDF engine, so it runs.
      number('dpi', p.dpi, POSITIVE_INT, p.dpi !== 0);
      if (p.compression && JSON.stringify(effectiveCompression(p.compression)) !== JSON.stringify({ tier: p.compression.tier, factor: p.compression.factor })) problems.push({ param: 'compression', message: `compression ${JSON.stringify(p.compression)} is not a tier Clop knows with a factor from 0 to 100` }, false);
      break;
    case 'downscale': number('factor', p.factor, { above: 0, max: 1 }); break;
    case 'lowerBitrate': number('kbps', p.kbps, POSITIVE_INT); break;
    case 'convert': filled('to', p.to); if (p.to.trim() && !/^[a-z0-9]+$/i.test(p.to)) problems.push({ param: 'to', message: `to must be a format extension such as webp or mp4, got "${p.to}"` }, false); break;
    case 'crop':
      for (const key of ['width', 'height', 'longEdge'] as const) number(key, p[key], POSITIVE_INT);
      if (p.aspectRatio !== undefined && !parseAspectRatio(p.aspectRatio)) problems.push({ param: 'aspectRatio', message: `aspectRatio must look like 16:9 or 1.91:1, got "${p.aspectRatio}"` });
      if (p.width === undefined && p.height === undefined && p.longEdge === undefined && p.aspectRatio === undefined) problems.push({ message: 'crop needs width, height, longEdge or aspectRatio' });
      break;
    case 'extractPagesAsImages': oneOf('format', p.format, PAGE_FORMATS); oneOf('quality', p.quality, PAGE_QUALITIES); break;
    case 'targetSize': number('size', p.bytes, POSITIVE_INT); break;
    case 'watermark': filled('image', p.image); oneOf('position', p.position, WATERMARK_POSITIONS); number('opacity', p.opacity, { min: 0, max: 1 }); number('scale', p.scale, { above: 0, max: 1 }); break;
    case 'copy': case 'move': case 'rename': filled('to', p.to); break;
    case 'delete': filled('path', p.path); break;
    case 'filterIf': case 'filterIfNot': {
      const condition = p._0;
      if (!FILTER_FIELDS.some(({ key }) => condition[key] !== undefined)) problems.push({ message: `${textName(kind)} needs at least one condition` });
      for (const key of FILTER_COUNTS) number(key, condition[key], COUNT);
      for (const key of ['regex', 'nameContains', 'nameIs', 'copiedBy'] as const) filled(key, condition[key]);
      if (condition.types && (!condition.types.length || condition.types.some(type => !type.trim()))) problems.push({ param: 'types', message: 'types needs one or more file types, such as png jpeg' });
      break;
    }
    case 'changeSpeed': number('factor', p.factor, { above: 0 }); break;
    case 'capFps': number('fps', p.fps, POSITIVE_INT); break;
    // ffmpeg's loudnorm accepts integrated loudness targets from -70 to -5 LUFS.
    case 'normalize': number('lufs', p.lufs, { min: -70, max: -5 }); break;
    case 'runScript': if (!p.path?.trim() && !p.code?.trim()) problems.push({ message: 'runScript needs a path or code' }); break;
    case 'runShortcut': filled('name', p._0.name); break;
    case 'copyToClipboard': filled('relativeTo', p.relativeTo); break;
    case 'copyLinkForSending': number('expiration', p.expiration, { min: 0 }); break;
    case 'shelveWith': oneOf('app', p.app, SHELF_APPS); break;
    case 'uploadWith': oneOf('app', p.app, UPLOAD_APPS); break;
    case 'openWith': filled('app', p.app); break;
  }
  return found;
}

const typeLabel = (type: ClopFileType) => type === 'pdf' ? 'PDF' : type;
/** The DSL names of the parameters a step has set, for checking which file types they apply to. */
function setParams(step: PipelineStep): string[] {
  const [kind, p] = stepEntry(step);
  if (kind === 'filterIf' || kind === 'filterIfNot') return Object.keys(p._0);
  if (kind === 'optimise') return [p.adaptive && 'adaptive', p.dpi !== undefined && 'dpi'].filter(name => typeof name === 'string');
  if (kind === 'changeSpeed') return p.frames ? ['frames'] : [];
  return [];
}

/** Steps, parameters and values that do not work on `fileType`, the way the editor only offers what applies (`stepTemplates(for:)`). */
export function typeProblems(step: PipelineStep, fileType: ClopFileType): StepProblem[] {
  const [kind, p] = stepEntry(step), name = textName(kind), template = stepTemplate(name);
  if (!template) return [];
  if (!template.applicableTypes.includes(fileType)) return [{ message: `${name} does not work on ${typeLabel(fileType)} files; it works on ${orList(template.applicableTypes.map(typeLabel))} files` }];
  const problems: StepProblem[] = [];
  // ifNot offers fewer keys in the editor but reads every `if` key.
  for (const param of stepParams(kind === 'filterIfNot' ? stepTemplate('if')! : template)) {
    if (param.applicableTypes && !param.applicableTypes.includes(fileType) && setParams(step).includes(param.name)) problems.push({ param: param.name, message: `${param.name} only works on ${orList(param.applicableTypes.map(typeLabel))} files` });
  }
  if (kind === 'optimise' && p.videoEncoder && fileType !== 'video') problems.push({ param: 'encoder', message: `encoder ${p.videoEncoder} is a video encoder; ${typeLabel(fileType)} pipelines take ${orList(ENCODER_QUALITIES)}` });
  if (kind === 'convert' && fileType !== 'pdf' && /^[a-z0-9]+$/i.test(p.to) && !CONVERT_TARGETS[fileType].includes(p.to.toLowerCase())) problems.push({ param: 'to', message: `Clop cannot convert ${typeLabel(fileType)} files to ${p.to}; use ${orList(CONVERT_TARGETS[fileType])}` });
  if (kind === 'copyToClipboard' && p.format === 'imageData' && fileType !== 'image') problems.push({ param: 'format', message: 'format imageData only works on image files; use path or markdown' });
  return problems;
}

const TIERS: Record<CompressionQuality['tier'], true> = { adaptive: true, lossless: true, fast: true, smaller: true, custom: true };
/** The compression a stored `optimise(compression:)` means, read the way the tolerant Swift decoder reads it: an unknown tier is custom, a factor that is not a whole number 50, and the factor clamped to 0–100. Stored values are kept as written. */
export function effectiveCompression(value: CompressionQuality): CompressionQuality {
  const tier = typeof value.tier === 'string' && Object.hasOwn(TIERS, value.tier) ? value.tier : 'custom';
  return { tier, factor: Number.isInteger(value.factor) ? Math.max(0, Math.min(100, value.factor)) : 50 };
}

/** What would stop a stored pipeline from running here, per step. Warnings only: a stored pipeline is kept and synced back whatever they say. */
export const pipelineProblems = (pipeline: Pipeline): (StepProblem & { step: number })[] => pipeline.steps.flatMap((step, index) =>
  [...stepProblems(step), ...(pipeline.fileType ? typeProblems(step, pipeline.fileType) : [])].map(problem => ({ ...problem, step: index })));

/** Built-in library pipelines have a stable `builtin-` id and show a "Built-in" badge. */
export const isBuiltin = (pipeline: Pipeline) => pipeline.id.startsWith('builtin-');
/** A new pipeline id, upper-case like Swift's `UUID().uuidString`. */
export const newPipelineId = () => globalThis.crypto.randomUUID().toUpperCase();
/** `Pipeline.reference(to:)`: a pipeline that runs a saved one and follows its edits. */
export const referenceTo = (saved: Pipeline): Pipeline => ({ id: newPipelineId(), steps: [], skipOptimisation: false, hideResult: false, libraryID: saved.id });
/** `Pipeline.resolved`: the saved pipeline a reference points to, or the pipeline itself when it is not a reference or the saved one was deleted. */
export const resolvePipeline = (pipeline: Pipeline, saved: readonly Pipeline[]) => pipeline.libraryID === undefined ? pipeline : saved.find(entry => entry.id === pipeline.libraryID) ?? pipeline;
