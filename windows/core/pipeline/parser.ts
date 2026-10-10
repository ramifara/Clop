import type { CompressionQuality } from '../settings/schema';
import {
  CLIPBOARD_FORMATS, ENCODER_QUALITIES, FILTER_FIELDS, LOCATION_KEYWORDS, PAGE_FORMATS, PAGE_QUALITIES, SHELF_APPS, UPLOAD_APPS, VIDEO_ENCODER_PRESETS, WATERMARK_POSITIONS,
  kindForTextName, makeStep, orList, resolvePipeline, stepEntry, stepProblems, textName, typeProblems,
  type ClopFileType, type FilterCondition, type FrameBehaviour, type Pipeline, type PipelineStep, type StepKind, type StepParamMap, type StepProblem,
} from './model';
import { stepParams, stepTemplate } from './templates';

// The pipeline DSL: `step(param: value, …) -> step -> …`, as `Pipeline.parseSteps` and `parsePipelineStep` (Pipeline.swift,
// Automation.swift) read it. `->` and line breaks always separate steps, even inside quotes, and a quoted value has no
// escapes, exactly as on macOS. Where macOS silently drops a step it cannot read, this parser reports why and where.

export interface PipelineIssue {
  message: string;
  /** 0-based index of the step the issue is in. */
  step?: number;
  /** Where in the text, when the issue comes from text. `line` and `column` are 1-based. */
  offset?: number;
  length?: number;
  line?: number;
  column?: number;
}
export const describeIssue = (issue: PipelineIssue) => issue.line !== undefined ? `Line ${issue.line}, column ${issue.column}: ${issue.message}` : issue.step !== undefined ? `Step ${issue.step + 1}: ${issue.message}` : issue.message;
export class PipelineError extends Error {
  constructor(readonly issues: PipelineIssue[]) {
    super(issues.map(describeIssue).join('\n'));
    this.name = 'PipelineError';
  }
}

export interface ParseOptions {
  /** Also reject steps, parameters and values that do not work on this file type. */
  fileType?: ClopFileType;
  /** The home folder: paths inside it are stored as `~/…` (`portablePathsInText`). */
  home?: string;
}

const QUOTES = new Set(['"', "'"]);

function distance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}
function didYouMean(word: string, candidates: readonly string[]) {
  const lower = word.toLowerCase();
  const best = candidates.map(candidate => ({ candidate, score: candidate.toLowerCase() === lower ? 0 : distance(lower, candidate.toLowerCase()) })).sort((a, b) => a.score - b.score)[0];
  return best && best.score <= (word.length >= 5 ? 2 : 1) ? `; did you mean ${best.candidate}?` : '';
}

/** `parseByteSize` (Automation.swift): `500KB`, `2mb`, `1.5MiB` or a byte count. */
export function parseByteSize(text: string): number | undefined {
  const s = text.trim().toLowerCase();
  if (/^[+-]?\d+$/.test(s)) return Number(s);
  for (const [suffix, multiplier] of [['gib', 1_073_741_824], ['gb', 1e9], ['mib', 1_048_576], ['mb', 1e6], ['kib', 1024], ['kb', 1000], ['b', 1]] as const) {
    if (!s.endsWith(suffix)) continue;
    const number = parseDecimal(s.slice(0, -suffix.length).trim());
    if (number !== undefined) return Math.trunc(number * multiplier);
  }
  return undefined;
}
/** `parseExpirationDuration` (WarpDropManager.swift): `30s`, `5m`, `1h`, `2d`, `never` or seconds. Never is 0. */
export function parseExpiration(text: string): number | undefined {
  const s = text.trim().toLowerCase();
  if (s === 'never' || s === '0') return 0;
  for (const [suffix, multiplier] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    if (!s.endsWith(suffix)) continue;
    const number = parseDecimal(s.slice(0, -1));
    if (number !== undefined && number >= 0) return number * multiplier;
  }
  const seconds = parseDecimal(s);
  return seconds !== undefined && seconds >= 0 ? seconds : undefined;
}
/** `parseCompressionValue` (Shared.swift): 5–100, `adaptive` (factor 30) or `auto` (factor 0). */
export function parseCompression(text: string): CompressionQuality | undefined {
  const s = text.toLowerCase();
  if (s === 'adaptive') return { tier: 'adaptive', factor: 30 };
  if (s === 'auto') return { tier: 'custom', factor: 0 };
  const factor = parseInteger(s);
  return factor !== undefined && factor >= 5 && factor <= 100 ? { tier: 'custom', factor } : undefined;
}
const parseInteger = (s: string) => /^[+-]?\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : undefined;
const parseDecimal = (s: string) => /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? Number(s) : undefined;
const parseFrames = (s: string): FrameBehaviour | undefined => ({ keep: 'keepFrames', keepframes: 'keepFrames', drop: 'dropFrames', dropframes: 'dropFrames' } as const)[s.toLowerCase() as 'keep'];
/** `parseResolution`: `640` or `640x480`, kept as its first number (both sides must reach it). */
const parseResolution = (s: string) => { const match = /^(\d+)(?:\s*[x×]\s*\d+)?$/i.exec(s.trim()); return match ? Number(match[1]) : undefined; };

/** `String.portablePathsInText`: every absolute path inside `home` becomes `~/…` (`~\…` when written with backslashes). Windows homes match case-insensitively. */
export function portablePathsInText(text: string, home?: string) {
  const parts = home?.split(/[\\/]+/).filter(Boolean);
  if (!home || !parts?.length) return text;
  const source = `${home.startsWith('/') ? '[\\\\/]' : ''}${parts.map(part => part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('[\\\\/]')}(?=[\\\\/])`;
  return text.replace(new RegExp(source, /^[a-z]:/i.test(home) ? 'gi' : 'g'), '~');
}
/** `Pipeline.cleanupPipelineText`: portable paths and a space on each side of `->`. */
export const cleanupPipelineText = (text: string, home?: string) => portablePathsInText(text, home).replaceAll(')->', ') ->').replaceAll('->(', '-> (');

interface Param { key: string; value: string; offset: number; length: number }
/** A step's trimmed text, and where the `->` that ended it is, if one did. */
interface Segment { text: string; offset: number; arrow?: number }

function segments(text: string): Segment[] {
  const out: Segment[] = [];
  const add = (from: number, to: number, arrow?: number) => {
    const raw = text.slice(from, to), trimmed = raw.trim();
    if (trimmed) out.push({ text: trimmed, offset: from + raw.length - raw.trimStart().length, arrow });
  };
  let start = 0;
  for (const match of text.matchAll(/->|\n/g)) { add(start, match.index, match[0] === '->' ? match.index : undefined); start = match.index + match[0].length; }
  add(start, text.length);
  return out;
}

class Args {
  private reported = false;
  constructor(private readonly params: Map<string, Param>, private readonly step: string, private readonly report: (message: string, param?: Param) => void, private readonly home?: string) {}
  get failed() { return this.reported; }
  fail(message: string, param?: Param) { this.reported = true; this.report(message, param); }
  string(key: string, required = false): string | undefined {
    const param = this.params.get(key);
    if (!param) { if (required) this.fail(`${this.step} needs ${key}`); return undefined; }
    if (!param.value.trim()) { this.fail(`${key} needs a value`, param); return undefined; }
    return portablePathsInText(param.value, this.home);
  }
  convert<T>(key: string, convert: (value: string) => T | undefined, expected: string, required = false): T | undefined {
    const text = this.string(key, required);
    if (text === undefined) return undefined;
    const value = convert(text);
    if (value === undefined) this.fail(`${key} must be ${expected}, got "${text}"`, this.params.get(key));
    return value;
  }
  int = (key: string, required = false) => this.convert(key, parseInteger, 'a whole number', required);
  number = (key: string, required = false) => this.convert(key, parseDecimal, 'a number', required);
  bool = (key: string) => this.convert(key, value => value === 'true' ? true : value === 'false' ? false : undefined, 'true or false');
  choice = <const V extends string>(key: string, values: readonly V[], { lowercase = false, required = false } = {}) => this.convert(key, value => values.find(v => v === (lowercase ? value.toLowerCase() : value)), orList(values), required);
}

const FILTER_COUNTS = ['fileSizeGreaterThan', 'fileSizeLowerThan', 'widthGreaterThan', 'widthLowerThan', 'heightGreaterThan', 'heightLowerThan', 'dpiGreaterThan', 'dpiLowerThan'] as const;
const filter = (a: Args): FilterCondition => ({
  types: a.string('types')?.split(' ').filter(Boolean), regex: a.string('regex'), nameContains: a.string('nameContains'), nameIs: a.string('nameIs'),
  ...Object.fromEntries(FILTER_COUNTS.map(key => [key, a.int(key)])),
  minFileSize: a.convert('minFileSize', parseByteSize, 'a size such as 100kb or 2mb'), minResolution: a.convert('minResolution', parseResolution, 'a size such as 640x480'), copiedBy: a.string('copiedBy'),
});

/** Text parameters → associated values, one per case, following `parsePipelineStep`. */
const READERS: { [K in StepKind]: (a: Args) => Partial<StepParamMap[K]> } = {
  optimise: a => {
    const encoder = a.choice('encoder', [...ENCODER_QUALITIES, ...VIDEO_ENCODER_PRESETS]);
    const video = VIDEO_ENCODER_PRESETS.find(preset => preset === encoder);
    return { encoder: video ? 'medium' : ENCODER_QUALITIES.find(quality => quality === encoder), videoEncoder: video, adaptive: a.bool('adaptive'), dpi: a.int('dpi'), location: a.string('location'), compression: a.convert('compression', parseCompression, '5 to 100, adaptive or auto') };
  },
  downscale: a => ({ factor: a.number('factor', true), location: a.string('location') }),
  lowerBitrate: a => ({ kbps: a.int('kbps', true), location: a.string('location') }),
  convert: a => ({ to: a.string('to', true), location: a.string('location') }),
  crop: a => ({ width: a.int('width'), height: a.int('height'), longEdge: a.int('longEdge'), aspectRatio: a.string('aspectRatio'), smartCrop: a.bool('smartCrop'), location: a.string('location') }),
  extractPagesAsImages: a => ({ format: a.choice('format', PAGE_FORMATS), quality: a.choice('quality', PAGE_QUALITIES), location: a.string('location') }),
  targetSize: a => ({ bytes: a.convert('size', parseByteSize, 'a size such as 500KB or 10MB', true), location: a.string('location') }),
  stripExif: () => ({}),
  watermark: a => ({ image: a.string('image', true), position: a.choice('position', WATERMARK_POSITIONS), opacity: a.number('opacity'), scale: a.number('scale'), location: a.string('location') }),
  copy: a => ({ to: a.string('to', true) }),
  move: a => ({ to: a.string('to', true) }),
  rename: a => ({ to: a.string('to', true) }),
  delete: a => ({ path: a.string('path', true) }),
  filterIf: a => ({ _0: filter(a) }),
  filterIfNot: a => ({ _0: filter(a) }),
  removeAudio: () => ({}),
  changeSpeed: a => ({ factor: a.number('factor', true), frames: a.convert('frames', parseFrames, 'keep or drop') }),
  capFps: a => ({ fps: a.int('fps', true) }),
  normalize: a => ({ lufs: a.number('lufs') }),
  runScript: a => {
    const path = a.string('path'), code = a.string('code');
    if (path !== undefined && code !== undefined) a.fail('runScript takes a path or code, not both');
    return { path, code };
  },
  runShortcut: a => { const name = a.string('name', true); return name === undefined ? {} : { _0: { name, identifier: name } }; },
  copyToClipboard: a => ({ format: a.choice('format', CLIPBOARD_FORMATS), relativeTo: a.string('relativeTo') }),
  copyLinkForSending: a => ({ expiration: a.convert('expiration', parseExpiration, 'a duration such as 15m, 1h, 3d or never') }),
  fork: a => ({ location: a.string('location') }),
  shelveWith: a => ({ app: a.choice('app', SHELF_APPS, { lowercase: true, required: true }) }),
  uploadWith: a => ({ app: a.choice('app', UPLOAD_APPS, { lowercase: true, required: true }) }),
  openWith: a => ({ app: a.string('app', true) }),
};

/** Every step the text describes, plus every problem found. Steps with problems are left out, so an editor can still preview the rest. */
export function parsePipelineText(text: string, { fileType, home }: ParseOptions = {}): { steps: PipelineStep[]; issues: PipelineIssue[] } {
  const lineStarts = [0, ...[...text.matchAll(/\n/g)].map(match => match.index + 1)];
  const issues: PipelineIssue[] = [], steps: PipelineStep[] = [];
  const issue = (step: number, message: string, offset: number, length: number) => {
    let line = lineStarts.length - 1;
    while (lineStarts[line] > offset) line--;
    issues.push({ message, step, offset, length, line: line + 1, column: offset - lineStarts[line] + 1 });
  };

  let skipUntil = -1;
  segments(text).forEach((segment, index) => {
    // The rest of a value that "->" cut in two is already reported.
    if (segment.offset <= skipUntil) return;
    const fail = (message: string, offset = segment.offset, length = segment.text.length) => issue(index, message, offset, length);
    const name = /^\w+/.exec(segment.text)?.[0];
    if (!name) return fail(`Expected a step name, found "${segment.text}"`);
    const kind = kindForTextName(name);
    if (!kind) return fail(`Unknown step "${name}"${name === 'filterIf' ? '; did you mean if?' : name === 'filterIfNot' ? '; did you mean ifNot?' : didYouMean(name, ['if', 'ifNot', ...Object.keys(READERS).filter(k => !k.startsWith('filter'))])}`, segment.offset, name.length);
    const atName = (message: string) => fail(message, segment.offset, name.length);

    const rest = segment.text.slice(name.length), restOffset = segment.offset + name.length;
    let quote: { char: string; at: number } | undefined;
    const commas: number[] = [];
    for (let i = 0; i < rest.length; i++) {
      const char = rest[i];
      if (QUOTES.has(char)) quote = quote?.char === char ? undefined : quote ?? { char, at: i };
      else if (char === ',' && !quote) commas.push(i);
    }
    if (quote && segment.arrow !== undefined) {
      const close = text.indexOf(quote.char, segment.arrow);
      skipUntil = close < 0 ? text.length : close;
      return fail('"->" always separates steps, so it cannot appear inside a quoted value', segment.arrow, 2);
    }
    if (quote) return fail(`Unterminated ${quote.char} quote`, restOffset + quote.at, rest.length - quote.at);
    if (rest && !rest.startsWith('(')) return fail(`Expected "(" right after ${name}`, restOffset, rest.length);
    if (rest && !rest.endsWith(')')) return fail(`${name}(…) is missing its closing ")"`, restOffset, rest.length);

    const params = new Map<string, Param>();
    const template = stepTemplate(textName(kind))!;
    const allowed = kind === 'filterIf' || kind === 'filterIfNot' ? FILTER_FIELDS.map(({ key }) => key) : stepParams(template).map(param => param.name);
    let bad = false;
    const bounds = [0, ...commas, rest.length - 1];
    for (let i = 0; i + 1 < bounds.length && rest; i++) {
      const from = bounds[i] + 1, raw = rest.slice(from, bounds[i + 1]), part = raw.trim();
      if (!part) continue;
      const at = restOffset + from + raw.length - raw.trimStart().length, colon = part.indexOf(':');
      const key = colon < 0 ? '' : part.slice(0, colon).trim();
      if (!/^\w+$/.test(key)) {
        const only = allowed.includes(part) ? `; give it a value, as in ${part}: …` : template.mandatoryParams.length === 1 ? `; write ${name}(${template.mandatoryParams[0].name}: ${part})` : '';
        fail(`Expected "name: value", found "${part}"${only}`, at, part.length); bad = true; continue;
      }
      if (!allowed.includes(key)) { fail(`${name} has no parameter "${key}"${didYouMean(key, allowed) || `; it takes ${orList(allowed)}`}`, at, key.length); bad = true; continue; }
      if (params.has(key)) { fail(`${key} is given twice`, at, part.length); bad = true; continue; }
      const rawValue = part.slice(colon + 1), value = rawValue.trim(), valueAt = at + colon + 1 + rawValue.length - rawValue.trimStart().length;
      if (QUOTES.has(value[0]) && (value.length < 2 || !value.endsWith(value[0]))) { fail(`Unexpected text after the closing ${value[0]} quote`, valueAt, value.length); bad = true; continue; }
      params.set(key, { key, value: QUOTES.has(value[0]) ? value.slice(1, -1) : value, offset: valueAt, length: value.length });
    }
    if (bad) return;

    const args = new Args(params, name, (message, param) => param ? fail(message, param.offset, param.length) : atName(message), home);
    const values = (READERS[kind] as (a: Args) => object)(args);
    if (args.failed) return;
    const step = makeStep(kind, values as Partial<StepParamMap[StepKind]>);
    const problems: StepProblem[] = [...stepProblems(step), ...(fileType ? typeProblems(step, fileType) : [])];
    for (const problem of problems) {
      const param = problem.param ? params.get(problem.param) : undefined;
      if (param) fail(problem.message, param.offset, param.length); else atName(problem.message);
    }
    if (!problems.length) steps.push(step);
  });
  return { steps, issues };
}

/** The steps of a pipeline text. Throws a `PipelineError` listing every problem with its line and column. */
export function parseSteps(text: string, options: ParseOptions = {}): PipelineStep[] {
  const { steps, issues } = parsePipelineText(text, options);
  if (issues.length) throw new PipelineError(issues);
  return steps;
}

/** `Pipeline.updateFromText`: the cleaned-up text becomes `rawText` and its steps replace the stored ones. Validates against the pipeline's file type. */
export const updateFromText = (pipeline: Pipeline, text: string, { home }: Pick<ParseOptions, 'home'> = {}): Pipeline =>
  ({ ...pipeline, steps: parseSteps(text, { fileType: pipeline.fileType, home }), rawText: cleanupPipelineText(text, home) });

/** `Pipeline.displayText`: what the user wrote, or the steps written out; a reference shows the saved pipeline's name. */
export function displayText(pipeline: Pipeline, saved: readonly Pipeline[] = []): string {
  const resolved = resolvePipeline(pipeline, saved);
  if (pipeline.libraryID !== undefined) return resolved.name ?? resolved.rawText ?? formatSteps(resolved.steps);
  return pipeline.rawText ?? formatSteps(pipeline.steps);
}

// Writing steps as text. Defaults are left out, paths, names and patterns are quoted, and every value is written so it
// parses back to the same step. A value holding both quote characters, `->` or a line break cannot be written losslessly.
const decimal = (value: number) => Number.isInteger(value) && Math.abs(value) < 1e15 ? value.toFixed(1) : String(value);
const quoted = (value: string) => value.includes('"') && !value.includes("'") ? `'${value}'` : `"${value}"`;
const bare = (value: string) => !value || value !== value.trim() || /[,"'()\n]|->/.test(value) ? quoted(value) : value;
const locationText = (value: string) => (LOCATION_KEYWORDS as readonly string[]).includes(value) ? value : quoted(value);
/** A byte count in the shortest unit that parses back to exactly the same number. */
export function formatByteSize(bytes: number): string {
  for (const [suffix, unit] of [['GB', 1e9], ['MB', 1e6], ['KB', 1e3]] as const) {
    if (bytes < unit) continue;
    for (let decimals = 0; decimals <= 2; decimals++) {
      const text = `${Number((bytes / unit).toFixed(decimals))}${suffix}`;
      if (parseByteSize(text) === bytes) return text;
    }
  }
  return String(bytes);
}
/** `expirationShortLabel` (1m, 6h, 3d) when it is exact, otherwise seconds. */
export function formatExpiration(seconds: number): string {
  if (seconds <= 0) return 'never';
  const label = seconds % 86400 === 0 ? `${seconds / 86400}d` : seconds % 3600 === 0 ? `${seconds / 3600}h` : `${Math.max(1, Math.floor(seconds / 60))}m`;
  return parseExpiration(label) === seconds ? label : `${seconds}s`;
}
const compressionText = ({ tier, factor }: CompressionQuality) => tier === 'adaptive' ? 'adaptive' : tier === 'custom' && factor === 0 ? 'auto' : String(factor);

/** One step as DSL text, the inverse of the parser: `parseSteps(formatStep(step))` gives back `[step]`, except for a Shortcut's identifier, which text does not carry (macOS looks shortcuts up by name). */
export function formatStep(step: PipelineStep): string {
  const [kind, p] = stepEntry(step), args: string[] = [];
  const add = (key: string, value: string | undefined) => { if (value !== undefined) args.push(`${key}: ${value}`); };
  const location = (value: string, fallback: string) => add('location', value === fallback ? undefined : locationText(value));
  switch (kind) {
    case 'optimise':
      add('encoder', p.videoEncoder ?? (p.encoder === 'medium' ? undefined : p.encoder));
      add('adaptive', p.adaptive ? 'true' : undefined);
      add('compression', p.compression && compressionText(p.compression));
      add('dpi', p.dpi?.toString());
      location(p.location, 'inPlace');
      break;
    case 'downscale': add('factor', decimal(p.factor)); location(p.location, 'inPlace'); break;
    case 'lowerBitrate': add('kbps', String(p.kbps)); location(p.location, 'inPlace'); break;
    case 'convert': add('to', bare(p.to)); location(p.location, 'sameFolder'); break;
    case 'crop':
      add('aspectRatio', p.aspectRatio && bare(p.aspectRatio));
      for (const key of ['longEdge', 'width', 'height'] as const) add(key, p[key]?.toString());
      add('smartCrop', p.smartCrop ? 'true' : undefined);
      location(p.location, 'inPlace');
      break;
    case 'extractPagesAsImages':
      add('format', p.format === 'jpeg' ? undefined : p.format);
      add('quality', p.quality === 'medium' ? undefined : p.quality);
      location(p.location, 'sameFolder');
      break;
    case 'targetSize': add('size', formatByteSize(p.bytes)); location(p.location, 'inPlace'); break;
    case 'watermark':
      add('image', quoted(p.image));
      add('position', p.position === 'bottomRight' ? undefined : p.position);
      add('opacity', p.opacity === 1 ? undefined : decimal(p.opacity));
      add('scale', p.scale === 0.15 ? undefined : decimal(p.scale));
      location(p.location, 'inPlace');
      break;
    case 'copy': case 'move': case 'rename': add('to', quoted(p.to)); break;
    case 'delete': add('path', quoted(p.path)); break;
    case 'filterIf': case 'filterIfNot': {
      const c = p._0;
      if (c.types?.length) add('types', bare(c.types.join(' ')));
      for (const key of ['regex', 'nameContains', 'nameIs'] as const) add(key, c[key] === undefined ? undefined : quoted(c[key]));
      for (const key of FILTER_COUNTS) add(key, c[key]?.toString());
      add('minFileSize', c.minFileSize === undefined ? undefined : formatByteSize(c.minFileSize));
      add('minResolution', c.minResolution === undefined ? undefined : `${c.minResolution}x${c.minResolution}`);
      add('copiedBy', c.copiedBy === undefined ? undefined : quoted(c.copiedBy));
      break;
    }
    case 'changeSpeed': add('factor', decimal(p.factor)); add('frames', p.frames && (p.frames === 'keepFrames' ? 'keep' : 'drop')); break;
    case 'capFps': add('fps', String(p.fps)); break;
    case 'normalize': add('lufs', p.lufs === -16 ? undefined : decimal(p.lufs)); break;
    case 'runScript': if (p.code) add('code', quoted(p.code)); else add('path', p.path === undefined ? undefined : quoted(p.path)); break;
    case 'runShortcut': add('name', quoted(p._0.name)); break;
    case 'copyToClipboard': add('format', p.format === 'path' ? undefined : p.format); add('relativeTo', p.relativeTo === undefined ? undefined : quoted(p.relativeTo)); break;
    case 'copyLinkForSending': add('expiration', p.expiration === undefined ? undefined : formatExpiration(p.expiration)); break;
    case 'fork': add('location', p.location === undefined ? undefined : locationText(p.location)); break;
    case 'shelveWith': case 'uploadWith': case 'openWith': add('app', bare(p.app)); break;
  }
  return args.length ? `${textName(kind)}(${args.join(', ')})` : textName(kind);
}

export const formatSteps = (steps: readonly PipelineStep[]) => steps.map(formatStep).join(' -> ');
