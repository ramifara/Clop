import { isDeepStrictEqual } from 'node:util';

// `JSONCEditor` (Clop/JSONCEditor.swift): adds and removes one member of one top-level object in a JSON file AS TEXT,
// so comments, trailing commas, key order and formatting elsewhere survive byte for byte. Zed's settings and VS Code's
// mcp.json are JSON with comments, and parse-then-stringify would drop them.
//
// Positions are UTF-16 code units of the original text; the sanitised copy keeps every unit where it was, which is
// what lets the scanner read the clean copy and splice the original. CRLF files get CRLF in what is inserted.

export class NotAnObjectError extends Error {}

const isNewline = (c: string | undefined) => c === '\n' || c === '\r';
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** The text as parseable JSON: comments and trailing commas blanked, every other unit left where it was. */
export function sanitized(text: string): string {
  const out = text.split('');
  let i = 0, inString = false, lastComma: number | undefined;
  while (i < out.length) {
    const c = out[i];
    if (inString) {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '/' && out[i + 1] === '/') {
      while (i < out.length && !isNewline(out[i])) out[i++] = ' ';
      continue;
    }
    if (c === '/' && out[i + 1] === '*') {
      while (i < out.length) {
        const end = out[i] === '*' && out[i + 1] === '/';
        // Newlines stay, so line numbers in any parse error still line up.
        if (!isNewline(out[i])) out[i] = ' ';
        if (end) { out[i + 1] = ' '; i += 2; break; }
        i++;
      }
      continue;
    }
    switch (c) {
      case '"': inString = true; lastComma = undefined; break;
      case ',': lastComma = i; break;
      case '}': case ']': if (lastComma !== undefined) out[lastComma] = ' '; lastComma = undefined; break;
      case ' ': case '\t': case '\n': case '\r': break;
      default: lastComma = undefined;
    }
    i++;
  }
  return out.join('');
}

/** The file's object, comments taken out. `{}` for an empty file; throws when the text is not an object. */
export function readObject(text: string): Record<string, unknown> {
  // Empty, or comments alone: there is an object to fill, as `setMember` does.
  const clean = sanitized(text);
  if (!clean.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(clean); } catch { throw new NotAnObjectError('not a JSON object'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NotAnObjectError('not a JSON object');
  return value as Record<string, unknown>;
}

/**
 * Whether a splice did only what was asked: `after` parses, `root[container][name]` is there (or gone), and everything else,
 * every other top-level key and every other member of the container, is what it was. Checked before anything is written.
 */
export function onlyMemberChanged(before: string, after: string, container: string, name: string, present: boolean): boolean {
  try {
    const split = (root: Record<string, unknown>) => {
      const { [container]: servers, ...rest } = root;
      const members = servers && typeof servers === 'object' && !Array.isArray(servers) ? { ...servers as Record<string, unknown> } : servers === undefined ? {} : undefined;
      if (!members) return undefined;
      const { [name]: entry, ...others } = members;
      return { rest, others, entry };
    };
    const was = split(readObject(before)), now = split(readObject(after));
    return !!was && !!now && isDeepStrictEqual(was.rest, now.rest) && isDeepStrictEqual(was.others, now.others) && (now.entry !== undefined) === present;
  } catch { return false; }
}

/**
 * Puts `member` (already formatted, written verbatim) under `root[container][name]`, replacing a member of that name.
 * Creates the container when it is missing, and the object when the file holds none.
 */
export function setMember(text: string, container: string, name: string, member: string): string {
  const clean = sanitized(text), rootBrace = firstBrace(clean);
  const crlf = text.includes('\r\n'), nl = (s: string) => crlf ? s.replace(/\n/g, '\r\n') : s;
  if (rootBrace === undefined) {
    // Something that is not an object is still the user's file, and writing over it would lose what it held.
    if (!/^\s*$/.test(clean)) throw new NotAnObjectError('not a JSON object');
    // Empty, or comments with no object under them: the file gets one, and what it held stays on top.
    const object = nl(`{\n  "${container}": {\n    "${name}": ${indented(member, '    ')}\n  }\n}\n`), kept = text.trim();
    return kept ? `${kept}${nl('\n')}${object}` : object;
  }
  const containerSpan = memberValueSpan(clean, rootBrace, container);
  if (!containerSpan) return insert(container, `{\n  "${name}": ${indented(member, '  ')}\n}`, rootBrace, text, clean, nl);
  if (clean[containerSpan[0]] !== '{') throw new NotAnObjectError(`${container} is not a JSON object`);
  // Replacing rather than appending keeps a re-install idempotent instead of writing a duplicate key.
  const existing = memberSpan(clean, containerSpan[0], name);
  if (existing) {
    const pad = lineIndent(text, existing[0]);
    return text.slice(0, existing[0]) + nl(`"${name}": ${indented(member, pad)}`) + text.slice(existing[1]);
  }
  return insert(name, member, containerSpan[0], text, clean, nl);
}

/** Drops `root[container][name]`, and the container with it when that was its only member. Undefined when it was not there. */
export function removeMember(text: string, container: string, name: string): string | undefined {
  const clean = sanitized(text), rootBrace = firstBrace(clean);
  if (rootBrace === undefined) return undefined;
  const containerSpan = memberValueSpan(clean, rootBrace, container);
  if (!containerSpan || clean[containerSpan[0]] !== '{') return undefined;
  const span = memberSpan(clean, containerSpan[0], name);
  if (!span) return undefined;
  const whole = memberCount(clean, containerSpan[0]) === 1 ? memberSpan(clean, rootBrace, container) : undefined;
  return cut(whole ?? span, text, clean);
}

// Scanning

function firstBrace(clean: string): number | undefined {
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '{') return i;
    if (!isSpace(clean[i])) return undefined;
  }
  return undefined;
}

const skipSpace = (clean: string, i: number) => { while (i < clean.length && isSpace(clean[i])) i++; return i; };

function endOfString(clean: string, start: number): number | undefined {
  for (let i = start + 1; i < clean.length; i++) {
    if (clean[i] === '\\') { i++; continue; }
    if (clean[i] === '"') return i;
  }
  return undefined;
}

/** One past the last unit of the value starting at `start`. */
function endOfValue(clean: string, start: number): number | undefined {
  if (clean[start] === '"') { const end = endOfString(clean, start); return end === undefined ? undefined : end + 1; }
  if (clean[start] === '{' || clean[start] === '[') {
    for (let i = start, depth = 0; i < clean.length; i++) {
      const c = clean[i];
      if (c === '"') { const end = endOfString(clean, i); if (end === undefined) return undefined; i = end; }
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { if (--depth === 0) return i + 1; }
    }
    return undefined;
  }
  let i = start;
  while (i < clean.length && !',}]'.includes(clean[i])) i++;
  // Trailing space belongs to the gap between members, not the value.
  while (i > start && isSpace(clean[i - 1])) i--;
  return i;
}

/** Each member of the object opening at `brace`: its key, the whole `"key": value` span and the value's span. Stops when `body` returns true. */
function forEachMember(clean: string, brace: number, body: (key: string, member: [number, number], value: [number, number]) => boolean) {
  let i = brace + 1;
  while (i < clean.length) {
    i = skipSpace(clean, i);
    if (clean[i] !== '"') return;
    const keyEnd = endOfString(clean, i);
    if (keyEnd === undefined) return;
    let j = skipSpace(clean, keyEnd + 1);
    if (clean[j] !== ':') return;
    j = skipSpace(clean, j + 1);
    const valueEnd = j < clean.length ? endOfValue(clean, j) : undefined;
    if (valueEnd === undefined) return;
    if (body(clean.slice(i + 1, keyEnd), [i, valueEnd], [j, valueEnd])) return;
    i = skipSpace(clean, valueEnd);
    if (clean[i] === ',') i++;
  }
}

function memberCount(clean: string, brace: number) { let count = 0; forEachMember(clean, brace, () => { count++; return false; }); return count; }
function memberSpan(clean: string, brace: number, name: string) { let found: [number, number] | undefined; forEachMember(clean, brace, (key, member) => key === name && !!(found = member)); return found; }
function memberValueSpan(clean: string, brace: number, name: string) { let found: [number, number] | undefined; forEachMember(clean, brace, (key, _, value) => key === name && !!(found = value)); return found; }

// Splicing

/** Re-indents a multi-line member so it sits under its new parent, with the parent line's own spaces or tabs. */
const indented = (member: string, pad: string) => member.split('\n').map((line, n) => n === 0 ? line : pad + line).join('\n');

/** The whitespace starting the line `offset` is on: what the file already uses beats any house style. */
function lineIndent(text: string, offset: number) {
  let start = Math.min(offset, text.length);
  while (start > 0 && !isNewline(text[start - 1])) start--;
  return /^[ \t]*/.exec(text.slice(start))![0];
}

/** Inserts as the FIRST member, which needs no knowledge of where the last one ends and never lands after a trailing comment. */
function insert(key: string, member: string, brace: number, text: string, clean: string, nl: (s: string) => string) {
  const after = skipSpace(clean, brace + 1), empty = after >= clean.length || clean[after] === '}';
  const closing = lineIndent(text, brace), pad = empty ? `${closing}  ` : lineIndent(text, after);
  const insertion = nl(`\n${pad}"${key}": ${indented(member, pad)}${empty ? `\n${closing}` : ','}`);
  return text.slice(0, brace + 1) + insertion + text.slice(brace + 1);
}

/** Cuts a member and exactly one comma beside it, so the object stays valid whether it was first, last or only. */
function cut([start, end]: [number, number], text: string, clean: string) {
  let lower = start, upper = end;
  const after = skipSpace(clean, upper);
  if (clean[after] === ',') upper = after + 1;
  else {
    // Last member: take the comma in front of it instead.
    let before = lower;
    while (before > 0 && isSpace(clean[before - 1])) before--;
    if (before > 0 && clean[before - 1] === ',') lower = before - 1;
  }
  // The member's own indentation and line break go too, so no empty line is left where it was.
  while (lower > 0 && (clean[lower - 1] === ' ' || clean[lower - 1] === '\t')) lower--;
  if (clean[lower - 1] === '\n') { lower--; if (clean[lower - 1] === '\r') lower--; }
  return text.slice(0, lower) + text.slice(upper);
}
