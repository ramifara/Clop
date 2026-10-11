import type { ClopFileType } from './model';
import { stepParams, stepTemplates, type StepCategory } from './templates';

// Syntax highlighting for pipeline text, from `highlightPipelineText` (Clop/PipelineTextView.swift): arrows dimmed, step
// names coloured by category, parameter names muted and values prominent; a step unknown for the file type and a value
// outside the type's suggestions are marked invalid. Offsets are UTF-16, as in a textarea.

export type TokenType = 'arrow' | 'step' | 'params' | 'param' | 'value' | 'invalid';
export interface Token { from: number; to: number; type: TokenType; category?: StepCategory }

export function highlightTokens(text: string, fileType?: ClopFileType): Token[] {
  const tokens: Token[] = [], templates = stepTemplates(fileType);
  for (const match of text.matchAll(/->/g)) tokens.push({ from: match.index, to: match.index + 2, type: 'arrow' });
  let start = 0;
  const segments: [number, number][] = [];
  for (const match of text.matchAll(/->|\r?\n/g)) { if (match.index > start) segments.push([start, match.index]); start = match.index + match[0].length; }
  if (start < text.length) segments.push([start, text.length]);
  for (const [from, to] of segments) {
    const raw = text.slice(from, to), segment = raw.trim();
    if (!segment) continue;
    const at = from + raw.indexOf(segment), paren = segment.indexOf('('), name = paren < 0 ? segment : segment.slice(0, paren);
    const template = templates.find(entry => entry.name === name);
    if (!template) { tokens.push({ from: at, to: at + segment.length, type: 'invalid' }); continue; }
    const { category } = template;
    tokens.push({ from: at, to: at + name.length, type: 'step', category });
    if (name.length === segment.length) continue;
    const params = segment.slice(name.length), paramsAt = at + name.length;
    tokens.push({ from: paramsAt, to: at + segment.length, type: 'params', category });
    for (const match of params.matchAll(/(\w+):\s*([^,)]+)/g)) {
      const key = match[1], value = match[2].trim(), keyAt = paramsAt + match.index;
      tokens.push({ from: keyAt, to: keyAt + key.length, type: 'param', category });
      const valueAt = keyAt + match[0].length - match[2].length + match[2].indexOf(value);
      const param = stepParams(template).find(entry => entry.name === key), allowed = fileType && param?.suggestionsForType?.[fileType];
      tokens.push({ from: valueAt, to: valueAt + value.length, type: allowed && !allowed.includes(value.replace(/^"|"$/g, '')) ? 'invalid' : 'value', category });
    }
  }
  return tokens.sort((a, b) => a.from - b.from || b.to - a.to);
}

export interface Span { text: string; type?: TokenType; category?: StepCategory; error?: boolean }
/**
 * The text cut into consecutive spans for display: each character takes the innermost token over it (a value inside a
 * step's parameters), and `errors` (offset and length, from the parser) mark what to underline.
 */
export function highlightSpans(text: string, tokens: readonly Token[], errors: readonly { offset?: number; length?: number }[] = []): Span[] {
  const marks: (Token | undefined)[] = new Array(text.length), wrong: boolean[] = new Array(text.length).fill(false);
  for (const token of tokens) for (let i = token.from; i < Math.min(token.to, text.length); i++) marks[i] = token;
  for (const { offset, length } of errors) if (offset !== undefined) for (let i = offset; i < Math.min(offset + Math.max(1, length ?? 1), text.length); i++) wrong[i] = true;
  const spans: Span[] = [];
  for (let i = 0; i < text.length; i++) {
    const mark = marks[i], last = spans.at(-1);
    if (last && i > 0 && marks[i - 1] === mark && wrong[i - 1] === wrong[i]) { last.text += text[i]; continue; }
    spans.push({ text: text[i], ...(mark ? { type: mark.type, category: mark.category } : {}), ...(wrong[i] ? { error: true } : {}) });
  }
  return spans;
}
