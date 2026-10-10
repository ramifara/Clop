import { randomInt } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from './settings/paths';

// Port of Shared/FileNameTemplate.swift. Tokens: %y year, %m month, %n month name, %d day, %w weekday
// (1 = Sunday), %H hour, %M minutes, %S seconds, %p AM/PM, %r five random letters, %i auto-incrementing
// number, %f file name without extension, %e extension, %P folder, %F full path.

/** The mutable number behind `%i`, like Swift's `inout autoIncrementingNumber`. Bumped only by templates that use `%i`. */
export interface Counter { value: number }
export interface TemplateContext {
  /** The file the template names. Provides `%f %e %P %F` and the extension appended to the result. */
  path?: string;
  counter?: Counter;
  now?: Date;
  /** Locale for `%n`. Defaults to the system locale, like `Calendar.monthSymbols`. */
  locale?: string;
  random?: () => string;
  /** Path rules to apply. Defaults to the running platform; tests use it to cover Windows paths on any host. */
  platform?: NodeJS.Platform;
  home?: string;
}

const pathApi = (platform = process.platform) => platform === 'win32' ? path.win32 : path.posix;
const pad = (value: number, size = 2) => String(value).padStart(size, '0');
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const randomLetters = () => Array.from({ length: 5 }, () => LETTERS[randomInt(LETTERS.length)]).join('');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** The characters `String.safeFilename` replaces on macOS, plus the ones Windows adds (`\ ?` and control characters). */
const UNSAFE = /[\\/:{}<>*|?$#&^;'"`\x00-\x1F]/g;
const replaceUnsafe = (text: string) => text.replace(UNSAFE, '_');

/** Port of `String.safeFilename`, extended for Windows: no trailing dot or space, and no reserved device name such as CON. Pass a file name, with or without extension, not a path. */
export function safeFileName(name: string): string {
  let safe = replaceUnsafe(name).replace(/[. ]+$/, match => '_'.repeat(match.length));
  const dot = safe.indexOf('.');
  const base = dot < 0 ? safe : safe.slice(0, dot);
  if (RESERVED.test(base)) safe = `${base}_${safe.slice(base.length)}`;
  return safe;
}

/** `%USERPROFILE%` (Windows only), `~`, `$HOME` and `${HOME}` at the start of a path mean the user's profile folder. */
export function resolveHome(value: string, home = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') value = value.replace(/^%USERPROFILE%(?=$|[\\/])/i, () => home);
  return expandHome(value, home, pathApi(platform));
}

/** Port of `generateFileName`: replaces the tokens, makes the result a safe file name unless `safe` is false, then appends the extension of `ctx.path`. */
export function expandTemplate(template: string, ctx: TemplateContext = {}, { safe = true, extension = true } = {}): string {
  const now = ctx.now ?? new Date(), p = pathApi(ctx.platform), file = ctx.path ? p.parse(ctx.path) : undefined;
  const number = (ctx.counter?.value ?? 0) + 1;
  let letters: string | undefined;
  const values: Record<string, () => string> = {
    y: () => pad(now.getFullYear(), 4), m: () => pad(now.getMonth() + 1), n: () => now.toLocaleString(ctx.locale, { month: 'long' }), d: () => pad(now.getDate()),
    w: () => String(now.getDay() + 1), H: () => pad(now.getHours()), M: () => pad(now.getMinutes()), S: () => pad(now.getSeconds()),
    // macOS compares `hour > 12`, so 12:00 to 12:59 reads AM there. Kept so both platforms name the same file the same.
    p: () => now.getHours() > 12 ? 'PM' : 'AM',
    r: () => letters ??= (ctx.random ?? randomLetters)(), i: () => String(number), F: () => ctx.path ?? '', P: () => file?.dir ?? '', f: () => file?.name ?? '', e: () => file?.ext.slice(1) ?? '',
  };
  // One pass over the template, so a value that contains `%d` is never expanded again.
  let name = template.replace(/%([ymndwHMSprifeFP])/g, (_, token: string) => values[token]());
  if (safe) name = safeFileName(name);
  if (extension && file?.ext) name += file.ext;
  if (ctx.counter && template.includes('%i')) ctx.counter.value = number;
  return name;
}

/**
 * Port of the path form of `generateFilePath`: expands the tokens and the home prefix, normalises, and
 * makes literal components safe file names. Components that hold `%P` or `%F`, and a leading home prefix,
 * are real folders and stay as they are, so `%P/optimised/%f` never renames a source folder such as
 * `Dev & Stuff`. The extension of `ctx.path` goes on the end. A relative result lands next to `ctx.path`.
 * Touches no files.
 */
export function expandPathTemplate(template: string, ctx: TemplateContext = {}): string {
  const platform = ctx.platform ?? process.platform, windows = platform === 'win32', p = pathApi(platform);
  const start = ctx.counter?.value ?? 0, home = windows ? /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%)$/i : /^(~|\$HOME|\$\{HOME\})$/;
  const parts = template.split(windows ? /[\\/]/ : '/').map((part, index) => {
    if (index === 0 && home.test(part)) return resolveHome(part, ctx.home, platform);
    // Each component reads the same counter value; it moves once, below.
    const expand = (piece: string) => expandTemplate(piece, { ...ctx, counter: ctx.counter && { value: start } }, { safe: false, extension: false });
    const value = expand(part);
    if (part === '.' || part === '..' || (index === 0 && windows && /^[A-Za-z]:$/.test(value))) return value;
    // The folders `%P` and `%F` stand for stay as they are; the literal text around them is made safe.
    if (/%[PF]/.test(part)) return part.split(/(%[PF])/).map(piece => /^%[PF]$/.test(piece) ? expand(piece) : replaceUnsafe(expand(piece))).join('');
    return safeFileName(value);
  });
  if (ctx.counter && template.includes('%i')) ctx.counter.value = start + 1;
  const ext = ctx.path ? p.parse(ctx.path).ext : '';
  const result = p.normalize(parts.join(p.sep) + ext);
  return !p.isAbsolute(result) && ctx.path ? p.join(p.dirname(ctx.path), result) : result;
}

/** Whether a path template starts at a fixed place (a root, `%P` or `%F`) rather than relative to the file. */
export function isAbsoluteTemplate(template: string, ctx: Pick<TemplateContext, 'platform' | 'home'> = {}): boolean {
  return /^%[PF]/.test(template) || pathApi(ctx.platform).isAbsolute(resolveHome(template, ctx.home, ctx.platform));
}

// `%n` takes any text without a separator: month names across locales contain spaces, hyphens, apostrophes,
// commas, `#`, ZWNJ and calendar marks (vi "Tháng 3", gd "An t-Ògmhios", as "মে’", he "אדר א׳").
const TOKEN_PATTERNS: Record<string, string> = {
  y: '\\d{4}', m: '\\d{2}', d: '\\d{2}', H: '\\d{2}', M: '\\d{2}', S: '\\d{2}', n: '[^/]+', w: '\\d', p: 'AM|PM', r: '[a-z]{5}', i: '\\d+', e: '[^./]+', f: '.+', P: '.+', F: '.+',
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Port of `nameMatchesTemplate`: whether `name` could have come out of `template`, so a template is never applied twice to one file. On Windows both sides are compared with `/` separators and ignoring case. */
export function nameMatchesTemplate(name: string, template: string, { allowPathPrefix = false, platform = process.platform }: { allowPathPrefix?: boolean; platform?: NodeJS.Platform } = {}): boolean {
  if (!template) return false;
  const windows = platform === 'win32';
  if (windows) { name = name.replaceAll('\\', '/'); template = template.replaceAll('\\', '/'); }
  let pattern = allowPathPrefix ? '^(?:.*/)?' : '^';
  for (const part of template.split(/(%.)/)) {
    const token = /^%(.)$/.exec(part)?.[1];
    pattern += token && TOKEN_PATTERNS[token] ? `(?:${TOKEN_PATTERNS[token]})` : escape(part);
  }
  return new RegExp(`${pattern}$`, windows ? 'iu' : 'u').test(name);
}
