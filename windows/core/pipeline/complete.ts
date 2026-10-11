import type { ClopFileType } from './model';
import { TEMPLATE_VARIABLES, paramApplies, paramSuggestions, paramValueDescriptions, stepParams, stepTemplates, type StepCategory } from './templates';

// The pipeline editor's typing aids, ported from `pipelineSuggestions` (Clop/Automation.swift) and the text view's
// coordinator (Clop/PipelineTextView.swift): suggestions for step names, parameters, values and template variables, and
// the edits that insert one, put ` -> ` after a finished step, and close a step. Positions are UTF-16 offsets, as in a
// textarea. Nothing here touches the DOM, so the renderer and tests share it.

export interface Suggestion {
  insertText: string;
  label: string;
  details: string;
  category: StepCategory;
  /** A step name whose parameters follow in parentheses. */
  opensParens: boolean;
  needsQuotes?: boolean;
  templateVariable?: boolean;
  /** The value fills the step's last parameter, so `)` follows it. */
  closesParens?: boolean;
}
export interface Edit { text: string; cursor: number }

const SEPARATOR = /->|\r?\n/g;
const lastSeparatorEnd = (text: string) => { let end = 0; for (const match of text.matchAll(SEPARATOR)) end = match.index + match[0].length; return end; };
const insideParens = (before: string) => before.split('(').length > before.split(')').length;

/** The step being typed: the text from the last `->` or line break up to the cursor, trimmed. */
export const currentStepPrefix = (text: string, cursor: number) => text.slice(lastSeparatorEnd(text.slice(0, cursor)), cursor).trim();

/** What can follow `prefix` (see `currentStepPrefix`): step names, then a step's parameters, then a parameter's values or template variables. */
export function suggestions(prefix: string, fileType?: ClopFileType): Suggestion[] {
  const templates = stepTemplates(fileType), trimmed = prefix.trim(), open = trimmed.indexOf('(');
  if (open >= 0) {
    const template = templates.find(entry => entry.name === trimmed.slice(0, open));
    if (!template) return [];
    const { category } = template;
    const parts = trimmed.slice(open + 1).split(',').map(part => part.trim()), last = parts.at(-1) ?? '';
    const used = new Set(parts.slice(0, -1).filter(part => part.includes(':')).map(part => part.split(':')[0].trim()));
    const params = stepParams(template).filter(param => paramApplies(param, fileType));
    if (last.includes(':')) {
      const colon = last.indexOf(':'), name = last.slice(0, colon).trim(), typed = last.slice(colon + 1).trim();
      const param = params.find(entry => entry.name === name);
      if (!param) return [];
      // Inside quotes the template variables show when nothing is typed yet or after a %.
      const quoted = typed.startsWith('"'), value = quoted ? typed.slice(1) : typed;
      if (quoted && (!value || value.includes('%'))) {
        const after = value.includes('%') ? value.slice(value.lastIndexOf('%') + 1) : '';
        return TEMPLATE_VARIABLES.filter(variable => !after || variable.token.slice(1).startsWith(after) || variable.name.toLowerCase().startsWith(after.toLowerCase()))
          .map(variable => ({ insertText: variable.token, label: variable.token, details: variable.description, category, opensParens: false, templateVariable: true }));
      }
      const filled = new Set([...used, name]), closesParens = params.every(entry => filled.has(entry.name)), descriptions = paramValueDescriptions(param, fileType);
      return paramSuggestions(param, fileType).filter(option => !typed || option.toLowerCase().startsWith(typed.toLowerCase()))
        .map(option => ({ insertText: option, label: option, details: descriptions[option] ?? param.description, category, opensParens: false, needsQuotes: option === 'template', closesParens }));
    }
    const lower = last.toLowerCase();
    return params.filter(param => !used.has(param.name) && (!lower || param.name.toLowerCase().includes(lower)))
      .map(param => ({ insertText: `${param.name}: `, label: param.name, details: param.description, category, opensParens: false, needsQuotes: param.needsQuotes }));
  }
  const lower = trimmed.toLowerCase();
  return templates.filter(template => !lower || template.name.toLowerCase().includes(lower)).map(template => {
    const hasParams = stepParams(template).length > 0;
    // A step whose only parameter is mandatory gets it written out: `copy(to: "`.
    const single = template.mandatoryParams.length === 1 && !template.optionalParams.length ? template.mandatoryParams[0] : undefined;
    return {
      insertText: single ? `${template.name}(${single.name}: ${single.needsQuotes ? '"' : ''}` : template.name, label: template.name, details: template.description,
      category: template.category, opensParens: hasParams && !single, needsQuotes: !!single?.needsQuotes,
    };
  });
}

const splice = (text: string, from: number, to: number, insert: string) => text.slice(0, from) + insert + text.slice(to);

/** Inserts `suggestion` at the cursor, replacing what it completes (`insertSuggestion`). */
export function insertSuggestion(text: string, cursor: number, suggestion: Suggestion): Edit {
  const before = text.slice(0, cursor);
  if (insideParens(before)) {
    const separator = Math.max(before.lastIndexOf('(') + 1, before.lastIndexOf(',') + 1), part = before.slice(separator);
    if (suggestion.templateVariable) {
      const percent = before.lastIndexOf('%'), from = percent < 0 ? cursor : percent;
      return { text: splice(text, from, cursor, suggestion.insertText), cursor: from + suggestion.insertText.length };
    }
    if (part.includes(':')) {
      const from = before.lastIndexOf(':') + 1;
      // A value that needs quotes (a `template` location) becomes empty quotes with the cursor between them.
      if (suggestion.needsQuotes) return { text: splice(text, from, cursor, ' ""'), cursor: from + 2 };
      const insert = ` ${suggestion.insertText}${suggestion.closesParens ? ')' : ', '}`;
      return { text: splice(text, from, cursor, insert), cursor: from + insert.length };
    }
    const prefix = separator > 0 && before[separator - 1] === '(' ? '' : ' ', insert = prefix + suggestion.insertText + (suggestion.needsQuotes ? '""' : '');
    return { text: splice(text, separator, cursor, insert), cursor: separator + insert.length - (suggestion.needsQuotes ? 1 : 0) };
  }
  // Outside parentheses the whole step under the cursor is replaced, keeping the space after a `->`.
  let start = lastSeparatorEnd(before);
  while (text[start] === ' ') start++;
  const next = [...text.slice(cursor).matchAll(SEPARATOR)][0];
  let end = next ? cursor + next.index : text.length;
  while (end > cursor && text[end - 1] === ' ') end--;
  let insert = suggestion.opensParens ? `${suggestion.insertText}(` : suggestion.insertText;
  if (suggestion.needsQuotes && !suggestion.opensParens) insert += '"';
  const at = start + insert.length - (suggestion.needsQuotes && !suggestion.opensParens ? 1 : 0);
  return { text: splice(text, start, end, insert), cursor: at };
}

/** Typing a letter right after a step's `)` starts the next step: ` -> ` goes in between (`autoInsertArrow`). */
export function autoInsertArrow(text: string, cursor: number): Edit | undefined {
  if (cursor < 2 || !/\p{L}/u.test(text[cursor - 1])) return undefined;
  let close = cursor - 2;
  while (close >= 0 && text[close] === ' ') close--;
  if (close < 0 || text[close] !== ')') return undefined;
  return { text: splice(text, close + 1, cursor - 1, ' -> '), cursor: close + 6 };
}

/** Closes the step the cursor is in: drops a trailing comma, closes an open quote, adds `)` and starts the next step with ` -> ` (`commitCurrentStep`). */
export function commitStep(text: string, cursor: number): Edit | undefined {
  const open = text.slice(0, cursor).lastIndexOf('(');
  if (open < 0) return undefined;
  const next = [...text.slice(open).matchAll(SEPARATOR)][0], end = next ? open + next.index : text.length;
  let inside = text.slice(open + 1, end).replace(/[,\s)]*$/, '');
  if ((inside.match(/"/g)?.length ?? 0) % 2) inside += '"';
  const committed = `${text.slice(0, open + 1)}${inside})${text.slice(end)} -> `;
  return { text: committed, cursor: committed.length };
}

/** Tab takes the first suggestion, or closes the step when there is nothing left to add (`handleTab`). Undefined when there is nothing to do. */
export function completeWithTab(text: string, cursor: number, fileType?: ClopFileType): Edit | undefined {
  const offered = suggestions(currentStepPrefix(text, cursor), fileType);
  if (!offered.length) return insideParens(text.slice(0, cursor)) ? commitStep(text, cursor) : undefined;
  const [first] = offered, edit = insertSuggestion(text, cursor, first);
  // After a value, the step closes once every parameter is filled in.
  const value = !first.opensParens && !first.needsQuotes && !first.insertText.endsWith(': ') && !first.templateVariable;
  if (value && !suggestions(currentStepPrefix(edit.text, edit.cursor), fileType).length) return commitStep(edit.text, edit.cursor) ?? edit;
  return edit;
}

/** The text once editing ends: no trailing `->`, no surrounding space. */
export const finishText = (text: string) => text.replace(/\s*->\s*$/, '').trim();
