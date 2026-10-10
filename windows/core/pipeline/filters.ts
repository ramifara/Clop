import { stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../media/detect';
import { probeImage } from '../media/image-codecs';
import { imageDPIs, loadPDF } from '../media/pdf';
import type { FilterCondition } from './model';

// `FilterCondition.evaluate` (Clop/PipelineStep.swift) for `if(...)` and `ifNot(...)`, and the ICU regular expressions
// macOS writes, read as JavaScript ones.

const KINDS: Record<string, readonly string[]> = { image: IMAGE_EXTENSIONS, video: VIDEO_EXTENSIONS, movie: VIDEO_EXTENSIONS, audio: AUDIO_EXTENSIONS, pdf: ['pdf'] };
/** The uniform type identifiers pipelines name, as the extension or kind they stand for. */
const UTIS: Record<string, string> = {
  'public.image': 'image', 'public.movie': 'video', 'public.video': 'video', 'public.audiovisual-content': 'video', 'public.audio': 'audio', 'com.adobe.pdf': 'pdf',
  'public.png': 'png', 'public.jpeg': 'jpeg', 'com.compuserve.gif': 'gif', 'org.webmproject.webp': 'webp', 'public.avif': 'avif', 'public.heic': 'heic', 'public.heif': 'heif',
  'public.jpeg-xl': 'jxl', 'public.tiff': 'tiff', 'com.microsoft.bmp': 'bmp', 'public.svg-image': 'svg', 'public.mpeg-4': 'mp4', 'com.apple.quicktime-movie': 'mov',
  'org.webmproject.webm': 'webm', 'public.mp3': 'mp3', 'public.mpeg-4-audio': 'm4a', 'com.microsoft.waveform-audio': 'wav', 'public.aiff-audio': 'aiff', 'org.xiph.flac': 'flac',
};
/** Extensions of one file type. A HEIC is a HEIF, as on macOS, but not the other way round. */
const SAME_TYPE: Record<string, readonly string[]> = { jpeg: ['jpeg', 'jpg', 'jpe'], jpg: ['jpeg', 'jpg', 'jpe'], tiff: ['tiff', 'tif'], tif: ['tiff', 'tif'], heif: ['heif', 'heic'], aiff: ['aiff', 'aif'], aif: ['aiff', 'aif'], mpeg: ['mpeg', 'mpg'], mpg: ['mpeg', 'mpg'], mov: ['mov', 'qt'] };

/** `types:` takes extensions (`png jpeg`), identifiers (`public.png`) and, on Windows, whole kinds (`image`). */
function matchesType(ext: string, type: string) {
  const wanted = UTIS[type.toLowerCase()] ?? type.toLowerCase().replace(/^\./, '');
  return KINDS[wanted]?.includes(ext) || (SAME_TYPE[wanted] ?? [wanted]).includes(ext);
}

const ICU_ONLY_ESCAPES: Record<string, string> = { h: '\\h (horizontal space)', H: '\\H', R: '\\R (line break)', X: '\\X (grapheme)', G: '\\G', N: '\\N{…} (named character)' };
const escapeLiteral = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * An ICU pattern (NSRegularExpression, which macOS pipelines use) as a JavaScript RegExp. Leading inline flags (`(?i)`,
 * `(?s)`, `(?m)`), possessive quantifiers (read as greedy), `\Q…\E` quoting and the `\A` and `\z` anchors are translated.
 * Anything else JavaScript cannot read throws an error that says so, instead of matching something else.
 */
export function icuRegex(pattern: string, flags = ''): RegExp {
  const unreadable = (what: string): never => { throw new Error(`The pattern "${pattern}" uses ${what}, which Clop for Windows cannot read. Rewrite it without that.`); };
  let source = pattern;
  const inline = /^\(\?([a-zA-Z]+)\)/.exec(source);
  if (inline) {
    for (const flag of inline[1]) {
      if (!'ims'.includes(flag)) unreadable(`the inline flag (?${flag})`);
      if (!flags.includes(flag)) flags += flag;
    }
    source = source.slice(inline[0].length);
  }
  let out = '', inClass = false, groupOpened = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1], afterGroupOpen = groupOpened;
    groupOpened = false;
    if (c === '\\') {
      if (next === 'Q') {
        const end = source.indexOf('\\E', i + 2);
        out += escapeLiteral(source.slice(i + 2, end < 0 ? undefined : end));
        i = end < 0 ? source.length : end + 1;
      } else if (!inClass && next === 'A') { out += '^'; i++; }
      else if (!inClass && (next === 'z' || next === 'Z')) { out += '$'; i++; }
      else if (next !== undefined && Object.hasOwn(ICU_ONLY_ESCAPES, next)) unreadable(ICU_ONLY_ESCAPES[next]);
      else if (next === 'x' && source[i + 2] === '{') unreadable('a \\x{…} code point');
      else { out += c + (next ?? ''); i++; }
      continue;
    }
    if (inClass) {
      // JavaScript (without the v flag) reads these as literal characters, so they would match something else.
      if (c === '[') unreadable('a nested or POSIX character class such as [[:alpha:]]');
      if (c === '&' && next === '&') unreadable('a class intersection (&&)');
      if (c === ']') inClass = false;
      out += c; continue;
    }
    if (c === '[') {
      inClass = true; out += c;
      if (next === '^') { out += next; i++; }
      if (source[i + 1] === ']') { out += '\\]'; i++; }
      continue;
    }
    if (c === '(' && next === '?' && source[i + 2] === '>') unreadable('an atomic group (?>…)');
    // The `?` of `(?:`, `(?=` and the like is not a quantifier.
    const quantifier = '*+?'.includes(c) && !afterGroupOpen;
    groupOpened = c === '(';
    out += c;
    // A `+` after a quantifier makes it possessive in ICU. JavaScript has none; greedy finds the same matches for the patterns
    // filenames need, but can backtrack where possessive would not, so a pathological pattern can be slower.
    if ((quantifier || (c === '}' && /\{\d+(,\d*)?\}$/.test(out))) && next === '+') i++;
  }
  try { return new RegExp(out, flags + (/\\[pP]\{/.test(out) ? 'u' : '')); } catch (error) {
    return unreadable(`syntax JavaScript rejects (${(error as Error).message})`);
  }
}

/** `regex:` is smart case: case-insensitive unless the pattern holds an upper-case letter that is not part of an escape such as `\S`. */
export const smartCaseRegex = (pattern: string) => icuRegex(pattern, /\p{Lu}/u.test(pattern.replace(/\\./g, '')) ? '' : 'i');

const size = (file: string) => stat(file).then(info => info.size, () => undefined);
const dimensions = (file: string) => probeImage(file).then(({ width, height }) => ({ width, height }), () => undefined);
async function dpi(file: string): Promise<number | undefined> {
  if (path.extname(file).toLowerCase() === '.pdf') {
    const dpis = await loadPDF(file).then(imageDPIs, () => []);
    return dpis.length ? Math.trunc(Math.max(...dpis)) : undefined;
  }
  const density = await sharp(file).metadata().then(meta => meta.density, () => undefined);
  return density && density > 0 ? Math.trunc(density) : undefined;
}

/** Whether `file` meets every condition, and the regex's capture groups when it does. */
export async function evaluateFilter(condition: FilterCondition, file: string, sourceApp?: { id?: string; name?: string }): Promise<{ matches: boolean; captures: string[] }> {
  const no = { matches: false, captures: [] }, name = path.basename(file), ext = path.extname(file).slice(1).toLowerCase();
  const captures: string[] = [];
  if (condition.types?.length && !condition.types.some(type => matchesType(ext, type))) return no;
  if (condition.regex) {
    const match = smartCaseRegex(condition.regex).exec(name);
    if (!match) return no;
    // Groups that took no part in the match are left out, as NSRegularExpression's ranges are.
    captures.push(...match.slice(1).filter((group): group is string => group !== undefined));
  }
  if (condition.nameContains && !name.toLocaleLowerCase().includes(condition.nameContains.toLocaleLowerCase())) return no;
  if (condition.nameIs && name !== condition.nameIs) return no;
  // A value that cannot be read (the width of a video, the DPI of a PNG without one) fails its condition, as on macOS.
  const fails = async (limit: number | undefined, read: () => Promise<number | undefined>, ok: (value: number) => boolean) => limit !== undefined && !await read().then(value => value !== undefined && ok(value));
  const bytes = () => size(file), width = async () => (await dimensions(file))?.width, height = async () => (await dimensions(file))?.height, dots = () => dpi(file);
  const c = condition;
  if (await fails(c.fileSizeGreaterThan, bytes, v => v > c.fileSizeGreaterThan!) || await fails(c.fileSizeLowerThan, bytes, v => v < c.fileSizeLowerThan!)
    || await fails(c.widthGreaterThan, width, v => v > c.widthGreaterThan!) || await fails(c.widthLowerThan, width, v => v < c.widthLowerThan!)
    || await fails(c.heightGreaterThan, height, v => v > c.heightGreaterThan!) || await fails(c.heightLowerThan, height, v => v < c.heightLowerThan!)
    || await fails(c.dpiGreaterThan, dots, v => v > c.dpiGreaterThan!) || await fails(c.dpiLowerThan, dots, v => v < c.dpiLowerThan!)
    || await fails(c.minFileSize, bytes, v => v >= c.minFileSize!)
    || await fails(c.minResolution, async () => { const d = await dimensions(file); return d && Math.min(d.width, d.height); }, v => v >= c.minResolution!)) return no;
  if (condition.copiedBy) {
    // Fuzzy: the app's executable or ID, or its name, contains the text, ignoring case.
    const needle = condition.copiedBy.toLowerCase();
    if (![sourceApp?.id, sourceApp?.name].some(hay => hay?.toLowerCase().includes(needle))) return no;
  }
  return { matches: true, captures };
}
