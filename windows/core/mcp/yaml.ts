import { ConfigLayoutError, ConfigLines, type Span } from './lines';

// `YAMLEditor` (Clop/MCPClients.swift): adds and removes one child of a top-level mapping in a YAML file as text. Only
// block style is handled, which is how Goose writes its config. A parent holding a non-empty flow mapping, tab
// indentation or a second document is refused rather than guessed at.

interface Found {
  parentLine: number;
  /** One past the parent's last line of content. */
  end: number;
  childIndent?: number;
  children: { name: string; span: Span }[];
  /** `parent: {}` or `parent: null`, which has to become `parent:` once it holds a child. */
  emptyFlow: boolean;
}

const isComment = (line: string) => /^ *#/.test(line);
const blankOrComment = (line: string) => ConfigLines.isBlank(line) || isComment(line);
const key = (name: string) => /^[\p{L}\p{N}_-]+$/u.test(name) ? name : `"${name}"`;
const childLines = (name: string, body: string[], indent: number) => { const pad = ' '.repeat(indent); return [`${pad}${key(name)}:`, ...body.map(line => `${pad}  ${line}`)]; };

/** The scalars and sequences set directly under `parent.name`, or undefined when there is no such child. */
export function childFields(text: string, parent: string, name: string): Record<string, string[]> | undefined {
  const lines = new ConfigLines(text).lines;
  let found: Found | undefined;
  try { found = locate(parent, lines); } catch { return undefined; }
  const child = found?.children.find(c => c.name === name);
  if (!child) return undefined;
  const fields: Record<string, string[]> = {}, body: number[] = [];
  for (let n = child.span[0] + 1; n < child.span[1]; n++) if (!blankOrComment(lines[n])) body.push(n);
  if (!body.length) return fields;
  const indent = ConfigLines.indent(lines[body[0]]);
  while (body.length) {
    const n = body.shift()!, pair = keyValue(lines[n]);
    if (ConfigLines.indent(lines[n]) !== indent || !pair) continue;
    const [field, value] = pair;
    if (value) { fields[field] = value.startsWith('[') ? flowSequence(value) : [scalar(value)]; continue; }
    // A block sequence may sit at the key's own indent, which is how serde writes it.
    const items: string[] = [];
    while (body.length && ConfigLines.indent(lines[body[0]]) >= indent) {
      const item = lines[body[0]].replace(/^ */, '').replace(/\r$/, '');
      if (!item.startsWith('- ') && item !== '-') break;
      items.push(scalar(item.slice(1)));
      body.shift();
    }
    fields[field] = items;
  }
  return fields;
}

/** Replaces `parent.name` with `body` indented under it: a new child goes at the end of `parent`, a new parent at the end of the file. */
export function setChild(text: string, parent: string, name: string, body: string[]): string {
  const file = new ConfigLines(text), found = locate(parent, file.lines);
  if (!found) {
    file.lines.push(...[`${key(parent)}:`, ...childLines(name, body, 2)].map(line => file.fresh(line)));
    return file.text;
  }
  const block = childLines(name, body, found.childIndent ?? 2).map(line => file.fresh(line));
  const child = found.children.find(c => c.name === name);
  if (child) file.lines.splice(child.span[0], child.span[1] - child.span[0], ...block);
  else {
    file.lines.splice(found.end, 0, ...block);
    if (found.emptyFlow) file.lines[found.parentLine] = file.fresh(`${key(parent)}:`);
  }
  return file.text;
}

/** Drops `parent.name`, and `parent` with it when that was its only child. Undefined when it was not there. */
export function removeChild(text: string, parent: string, name: string): string | undefined {
  const file = new ConfigLines(text), found = locate(parent, file.lines);
  const child = found?.children.find(c => c.name === name);
  if (!found || !child) return undefined;
  file.remove([found.children.length === 1 ? [found.parentLine, found.end] : child.span]);
  return file.text;
}

function locate(parent: string, lines: string[]): Found | undefined {
  let seenContent = false;
  const topLevel: { line: number; key: string; value: string }[] = [];
  for (const [n, line] of lines.entries()) {
    if (blankOrComment(line)) continue;
    if (/^[ \t]*/.exec(line)![0].includes('\t')) throw new ConfigLayoutError();
    const trimmed = line.trim();
    if (trimmed === '---' || trimmed.startsWith('--- ') || trimmed === '...') {
      if (seenContent) throw new ConfigLayoutError();
      continue;
    }
    seenContent = true;
    if (ConfigLines.indent(line) !== 0) continue;
    const pair = keyValue(line);
    if (!pair) throw new ConfigLayoutError();
    topLevel.push({ line: n, key: pair[0], value: pair[1] });
  }
  const index = topLevel.findIndex(entry => entry.key === parent);
  if (index < 0) return undefined;
  // A key listed twice is read differently by different parsers, so no edit is safe.
  if (topLevel.some((entry, n) => n !== index && entry.key === parent)) throw new ConfigLayoutError();
  const { line: parentLine, value } = topLevel[index], emptyFlow = ['{}', '~', 'null'].includes(value);
  if (value && !emptyFlow) throw new ConfigLayoutError();
  let end = index + 1 < topLevel.length ? topLevel[index + 1].line : lines.length;
  while (end > parentLine + 1 && blankOrComment(lines[end - 1])) end--;
  const content: number[] = [];
  for (let n = parentLine + 1; n < end; n++) if (!blankOrComment(lines[n])) content.push(n);
  if (emptyFlow && content.length) throw new ConfigLayoutError();
  if (!content.length) return { parentLine, end: parentLine + 1, children: [], emptyFlow };
  const childIndent = ConfigLines.indent(lines[content[0]]);
  if (lines[content[0]].replace(/^ */, '').startsWith('-')) throw new ConfigLayoutError();
  const starts: { name: string; line: number }[] = [];
  for (const n of content) {
    const indent = ConfigLines.indent(lines[n]);
    if (indent < childIndent) throw new ConfigLayoutError();
    if (indent !== childIndent) continue;
    const pair = keyValue(lines[n]);
    if (!pair) throw new ConfigLayoutError();
    starts.push({ name: pair[0], line: n });
  }
  if (new Set(starts.map(start => start.name)).size < starts.length) throw new ConfigLayoutError();
  const children = starts.map((start, m) => {
    let stop = m + 1 < starts.length ? starts[m + 1].line : end;
    while (stop > start.line + 1 && blankOrComment(lines[stop - 1])) stop--;
    return { name: start.name, span: [start.line, stop] as Span };
  });
  return { parentLine, end, childIndent, children, emptyFlow: false };
}

/** `key: value` with any comment taken off the value. Undefined for a line that is not a mapping entry. */
function keyValue(line: string): [string, string] | undefined {
  const s = line.replace(/^ */, '').replace(/^[\r\n]+|[\r\n]+$/g, '');
  const first = s[0];
  if (first === undefined || (first === '-' && !(s.length > 1 && s[1] !== ' '))) return undefined;
  let i = 0, name: string;
  if (first === '"' || first === "'") {
    for (i = 1; i < s.length && s[i] !== first;) i += s[i] === '\\' && first === '"' ? 2 : 1;
    if (i >= s.length) return undefined;
    name = scalar(s.slice(0, i + 1));
    i++;
    if (s[i] !== ':') return undefined;
  } else {
    while (i < s.length && !(s[i] === ':' && (i + 1 === s.length || s[i + 1] === ' '))) i++;
    if (i >= s.length) return undefined;
    name = s.slice(0, i).trim();
  }
  let value = s.slice(i + 1).trim();
  const hash = value.indexOf(' #');
  if (hash >= 0) value = value.slice(0, hash).trim();
  else if (value.startsWith('#')) value = '';
  return name ? [name, value] : undefined;
}

const flowSequence = (value: string) => value.slice(1).split(']')[0].split(',').map(item => scalar(item.trim())).filter(Boolean);

/** A scalar without its quotes. Double quotes take JSON's escapes. */
function scalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { const decoded = JSON.parse(`[${value}]`); if (typeof decoded[0] === 'string') return decoded[0]; } catch {}
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}
