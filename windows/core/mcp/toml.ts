import { ConfigLayoutError, ConfigLines, type Span } from './lines';

// `TOMLEditor` (Clop/MCPClients.swift): adds and removes one table in a TOML file as text, so comments, key order and
// formatting outside the table survive byte for byte. The scanner knows strings of all four kinds, comments, and arrays
// or inline tables over several lines; a file it cannot follow is refused rather than guessed at.

/** A table header or a `key = value` statement, and the lines it covers. */
interface Item { header: boolean; path: string[]; lines: Span; value: string }
type Mode = 'code' | 'basic' | 'literal' | 'multiBasic' | 'multiLiteral';

const startsWith = (path: string[], prefix: string[]) => prefix.length <= path.length && prefix.every((part, n) => path[n] === part);
const isComment = (line: string) => /^[ \t]*#/.test(line);
const isBare = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_-]/.test(c);
const key = (part: string) => part && [...part].every(isBare) ? part : `"${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The values set directly in the table at `path`, unparsed, or undefined when nothing defines it. */
export function tableValues(text: string, path: string[]): Record<string, string> | undefined {
  const items = scan(new ConfigLines(text).lines)?.filter(item => startsWith(item.path, path));
  if (!items?.length) return undefined;
  const values: Record<string, string> = {};
  for (const item of items) if (!item.header && item.path.length === path.length + 1) values[item.path[path.length]] = item.value;
  return values;
}

/** Replaces whatever defines the table at `path` with `[path]` and `body`, where the old one started or at the end. */
export function setTable(text: string, path: string[], body: string[]): string {
  const file = new ConfigLines(text), found = owned(path, file.lines);
  const block = [`[${path.map(key).join('.')}]`, ...body].map(line => file.fresh(line));
  const first = found.firstSection;
  if (!first) {
    file.remove(found.spans);
    const last = file.lines.at(-1);
    if (last !== undefined && !ConfigLines.isBlank(last)) file.lines.push(file.fresh(''));
    file.lines.push(...block);
    return file.text;
  }
  // The rest of ours goes first, then the block lands where the first table was.
  const dropped = file.remove(found.spans.filter(span => span !== first));
  const start = first[0] - [...dropped].filter(n => n < first[0]).length;
  file.lines.splice(start, first[1] - first[0], ...block);
  return file.text;
}

/** Drops everything that defines the table at `path`. Undefined when there was nothing to drop. */
export function removeTable(text: string, path: string[]): string | undefined {
  const file = new ConfigLines(text), found = owned(path, file.lines);
  if (!found.spans.length) return undefined;
  file.remove(found.spans);
  return file.text;
}

/** The strings in a value: the one string, or each element of an array of strings. Undefined for anything else. */
export function tomlStrings(value: string): string[] | undefined {
  const s = value;
  let i = skipSpace(s, 0, true);
  if (i >= s.length) return undefined;
  if (s[i] !== '[') { const one = parseString(s, i); return one ? [one.value] : undefined; }
  i++;
  const out: string[] = [];
  for (;;) {
    i = skipSpace(s, i, true);
    if (i >= s.length) return undefined;
    if (s[i] === ']') return out;
    const element = parseString(s, i);
    if (!element) return undefined;
    out.push(element.value);
    i = skipSpace(s, element.end, true);
    if (i >= s.length) return undefined;
    if (s[i] === ',') i++;
    else if (s[i] !== ']') return undefined;
  }
}

/**
 * The spans that define the table at `path`: its header sections (cut back to their last line of content, so a comment
 * heading the next table stays with it) and dotted keys reaching into it from elsewhere.
 */
function owned(path: string[], lines: string[]): { spans: Span[]; firstSection?: Span } {
  const items = scan(lines);
  if (!items) throw new ConfigLayoutError();
  // `mcp_servers = { … }` holds every server inline, and a table cannot be added beside it or cut out of it by lines.
  if (items.some(item => !item.header && item.path.length < path.length && startsWith(path, item.path))) throw new ConfigLayoutError();
  const headers = items.filter(item => item.header), sections: Span[] = [];
  headers.forEach((header, n) => {
    if (!startsWith(header.path, path)) return;
    let end = n + 1 < headers.length ? headers[n + 1].lines[0] : lines.length;
    while (end > header.lines[1] && (ConfigLines.isBlank(lines[end - 1]) || isComment(lines[end - 1]))) end--;
    sections.push([header.lines[0], end]);
  });
  const statements = items.filter(item => !item.header && startsWith(item.path, path)).map(item => item.lines)
    .filter(span => !sections.some(([start, end]) => span[0] >= start && span[0] < end));
  return { spans: [...sections, ...statements].sort((a, b) => a[0] - b[0]), firstSection: sections[0] };
}

/** Every header and statement, or undefined when the file has something this cannot follow. */
function scan(lines: string[]): Item[] | undefined {
  const items: Item[] = [];
  let table: string[] = [];
  for (let n = 0; n < lines.length; n++) {
    const s = lines[n];
    let i = skipSpace(s, 0, false);
    if (i >= s.length || s[i] === '#') continue;
    if (s[i] === '[') {
      const array = s[i + 1] === '[';
      const parsed = keyPath(s, i + (array ? 2 : 1));
      if (!parsed) return undefined;
      i = parsed.end;
      for (let k = 0; k < (array ? 2 : 1); k++) { if (s[i] !== ']') return undefined; i++; }
      i = skipSpace(s, i, false);
      if (i < s.length && s[i] !== '#') return undefined;
      table = parsed.path;
      items.push({ header: true, path: parsed.path, lines: [n, n + 1], value: '' });
      continue;
    }
    const parsed = keyPath(s, i);
    if (!parsed || s[parsed.end] !== '=') return undefined;
    // The value can run over several lines: a multi-line string, or an array.
    const state = { mode: 'code' as Mode, depth: 0 }, first = n;
    let value = '', line = s, start = parsed.end + 1;
    for (;;) {
      const end = advance(line, start, state);
      if (end === undefined || state.depth < 0) return undefined;
      value += line.slice(start, end);
      if (state.mode === 'code' && state.depth === 0) break;
      if (++n >= lines.length) return undefined;
      value += '\n';
      line = lines[n];
      start = 0;
    }
    items.push({ header: false, path: [...table, ...parsed.path], lines: [first, n + 1], value: value.trim() });
  }
  return items;
}

/**
 * Walks one line from `start`, carrying string and bracket state from the line before. Returns where the content ends
 * (a comment is not content), or undefined when a one-line string runs off the end of its line.
 */
function advance(s: string, start: number, state: { mode: Mode; depth: number }): number | undefined {
  let i = start;
  while (i < s.length) {
    const c = s[i];
    switch (state.mode) {
      case 'code':
        if (c === '#') return i;
        if (c === '"' || c === "'") {
          const triple = quotes(s, i, c) >= 3;
          state.mode = c === '"' ? triple ? 'multiBasic' : 'basic' : triple ? 'multiLiteral' : 'literal';
          if (triple) { i += 3; continue; }
        } else if (c === '[' || c === '{') state.depth++;
        else if (c === ']' || c === '}') state.depth--;
        break;
      case 'basic':
        if (c === '\\') { i += 2; continue; }
        if (c === '"') state.mode = 'code';
        break;
      case 'literal':
        if (c === "'") state.mode = 'code';
        break;
      default: {
        const quote = state.mode === 'multiBasic' ? '"' : "'";
        if (c === '\\' && state.mode === 'multiBasic') { i += 2; continue; }
        // Up to two quotes may sit right before the closing three, and belong to the string.
        const run = quotes(s, i, quote);
        if (run >= 3) { state.mode = 'code'; i += Math.min(run, 5); continue; }
        i += Math.max(run, 1);
        continue;
      }
    }
    i++;
  }
  return state.mode === 'basic' || state.mode === 'literal' ? undefined : s.length;
}

function quotes(s: string, start: number, quote: string) { let i = start; while (s[i] === quote) i++; return i - start; }
function skipSpace(s: string, i: number, newlines: boolean) { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r' || (newlines && s[i] === '\n'))) i++; return i; }

/** A dotted key, `a."b c".'d'`, ending after the space that follows it. */
function keyPath(s: string, i: number): { path: string[]; end: number } | undefined {
  const path: string[] = [];
  for (;;) {
    i = skipSpace(s, i, false);
    if (i >= s.length) return undefined;
    if (s[i] === '"' || s[i] === "'") {
      const part = parseString(s, i);
      if (!part) return undefined;
      path.push(part.value);
      i = part.end;
    } else {
      const start = i;
      while (isBare(s[i])) i++;
      if (i === start) return undefined;
      path.push(s.slice(start, i));
    }
    i = skipSpace(s, i, false);
    if (s[i] !== '.') return { path, end: i };
    i++;
  }
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', e: '\x1b' };

/** A one-line basic or literal string starting at `i`, escapes resolved, and where it ends. */
function parseString(s: string, i: number): { value: string; end: number } | undefined {
  const quote = s[i];
  if (quote !== '"' && quote !== "'") return undefined;
  let out = '';
  for (i++; i < s.length && s[i] !== quote;) {
    if (quote !== '"' || s[i] !== '\\' || i + 1 >= s.length) { out += s[i++]; continue; }
    const e = s[i + 1];
    i += 2;
    if (e === 'u' || e === 'U') {
      const length = e === 'u' ? 4 : 8, hex = s.slice(i, i + length);
      if (hex.length !== length || !/^[0-9a-fA-F]+$/.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) return undefined;
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += length;
    } else out += ESCAPES[e] ?? e;
  }
  if (i >= s.length) return undefined;
  return { value: out, end: i + 1 };
}
