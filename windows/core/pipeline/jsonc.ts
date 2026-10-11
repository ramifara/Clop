import { decodeStep } from './codec';
import { stepEntry, stepProblems, textName, typeProblems, type ClopFileType, type PipelineStep } from './model';
import { PipelineError, canFormat, formatStep, type PipelineIssue } from './parser';

// The pipeline editor's JSON view: the steps as their Codable JSON, one per line, each under a `//` comment with its text
// form. It reads JSON with comments and trailing commas the way `JSONCEditor.sanitized` (Clop/JSONCEditor.swift) does,
// and reports problems at their line and column. Steps that have no exact text form (`canFormat`) are edited here.

/** `JSONCEditor.sanitized`: comments and trailing commas blanked out, every other character where it was, line breaks kept. */
export function stripJsonc(text: string): string {
  const out = text.split('');
  let inString = false, lastComma: number | undefined;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
    if (c === '/' && out[i + 1] === '/') { while (i < out.length && out[i] !== '\n' && out[i] !== '\r') out[i++] = ' '; i--; continue; }
    if (c === '/' && out[i + 1] === '*') {
      for (; i < out.length; i++) {
        const end = out[i] === '*' && out[i + 1] === '/';
        if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
        if (end) { out[++i] = ' '; break; }
      }
      continue;
    }
    if (c === '"') { inString = true; lastComma = undefined; }
    else if (c === ',') lastComma = i;
    else if (c === '}' || c === ']') { if (lastComma !== undefined) out[lastComma] = ' '; lastComma = undefined; }
    else if (!/\s/.test(c)) lastComma = undefined;
  }
  return out.join('');
}

/** The steps as the JSON view shows them. */
export function stepsToJsonc(steps: readonly PipelineStep[]): string {
  if (!steps.length) return '[\n]';
  const lines = steps.map(step => `  // ${canFormat(step) ? formatStep(step) : `${textName(stepEntry(step)[0])}: no exact text form, edit it here`}\n  ${JSON.stringify(step)},`);
  return `[\n${lines.join('\n')}\n]`;
}

/** Where each element of the top-level array starts and ends in `clean` (comments already blanked). */
function elementSpans(clean: string): [number, number][] {
  const spans: [number, number][] = [];
  let depth = 0, inString = false, start = -1, solid = 0;
  const close = () => { if (start >= 0) spans.push([start, solid]); start = -1; };
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; solid = i + 1; continue; }
    if (depth === 1 && start < 0 && !/[\s,\]]/.test(c)) start = i;
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) close(); }
    else if (c === ',' && depth === 1) { close(); continue; }
    if (!/\s/.test(c)) solid = i + 1;
  }
  return spans;
}

/** Newer engines name the bad token but not where it is: the first offset whose prefix already cannot be completed into JSON. */
function firstBadOffset(clean: string): number {
  const broken = (length: number) => {
    try { JSON.parse(clean.slice(0, length)); return false; } catch (error) {
      const message = (error as Error).message, position = /position (\d+)/.exec(message);
      return !/end of JSON input|^Unterminated/.test(message) && (!position || Number(position[1]) < length);
    }
  };
  let low = 1, high = clean.length;
  if (!broken(high)) return Math.max(0, clean.length - 1);
  while (low < high) { const mid = (low + high) >> 1; if (broken(mid)) high = mid; else low = mid + 1; }
  return low - 1;
}

/**
 * The steps in a JSON view's text, with every problem: invalid JSON, a step the decoder refuses, and values that do not
 * work here or on `fileType`, each at its line and column. Steps with problems are left out.
 */
export function parseJsoncSteps(text: string, { fileType }: { fileType?: ClopFileType } = {}): { steps: PipelineStep[]; issues: PipelineIssue[] } {
  const lineStarts = [0, ...[...text.matchAll(/\n/g)].map(match => match.index + 1)];
  const at = (offset: number, length: number, message: string, step?: number): PipelineIssue => {
    let line = lineStarts.length - 1;
    while (lineStarts[line] > offset) line--;
    return { message, step, offset, length, line: line + 1, column: offset - lineStarts[line] + 1 };
  };
  const clean = stripJsonc(text);
  let value: unknown;
  try { value = JSON.parse(clean); } catch (error) {
    const message = (error as Error).message, position = /position (\d+)/.exec(message);
    const offset = position ? Math.min(Number(position[1]), Math.max(0, text.length - 1)) : firstBadOffset(clean);
    return { steps: [], issues: [at(offset, 1, `Not valid JSON: ${message.replace(/ in JSON at position.*$/, '').replace(/\s*\(line \d+ column \d+\)$/, '')}`)] };
  }
  if (!Array.isArray(value)) return { steps: [], issues: [at(Math.max(0, clean.search(/\S/)), 1, 'Write the steps as a JSON list: [ {"optimise":{}}, … ]')] };
  const spans = elementSpans(clean), steps: PipelineStep[] = [], issues: PipelineIssue[] = [];
  value.forEach((item, index) => {
    const [from, to] = spans[index] ?? [0, text.length];
    try {
      const step = decodeStep(item, index);
      const problems = [...stepProblems(step), ...(fileType ? typeProblems(step, fileType) : [])];
      for (const problem of problems) issues.push(at(from, to - from, problem.message, index));
      if (!problems.length) steps.push(step);
    } catch (error) {
      const messages = error instanceof PipelineError ? error.issues.map(issue => issue.message) : [(error as Error).message];
      for (const message of messages) issues.push(at(from, to - from, message, index));
    }
  });
  return { steps, issues };
}
