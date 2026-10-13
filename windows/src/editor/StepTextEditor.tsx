import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { autoInsertArrow, completeWithTab, currentStepPrefix, insertSuggestion, suggestions, type Edit } from '../../core/pipeline/complete';
import { highlightSpans, highlightTokens, jsoncTokens } from '../../core/pipeline/highlight';
import type { ClopFileType } from '../../core/pipeline/model';

/** An error to underline: where it is in the text, and what it says. */
export interface Problem { message: string; offset?: number; length?: number; line?: number; column?: number }

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl+Enter. */
  onSubmit?: () => void;
  fileType?: ClopFileType;
  /** `text` is the step language, with autocomplete; `json` the JSON view. */
  mode: 'text' | 'json';
  problems: readonly Problem[];
  label: string;
  placeholder?: string;
}

const MAX_SUGGESTIONS = 40;

/**
 * The pipeline text box (`PipelineTextView.swift`): the text is drawn highlighted under a transparent textarea, step names,
 * parameters, values and template variables complete as the user types, and each problem the parser finds is underlined where it is.
 */
export function StepTextEditor({ value, onChange, onSubmit, fileType, mode, problems, label, placeholder }: Props) {
  const area = useRef<HTMLTextAreaElement>(null), list = useRef<HTMLUListElement>(null), pending = useRef<number | undefined>(undefined);
  const [cursor, setCursor] = useState(0), [focused, setFocused] = useState(false), [choice, setChoice] = useState(0), [navigated, setNavigated] = useState(false), [closed, setClosed] = useState(false);
  const spans = useMemo(() => highlightSpans(value, mode === 'text' ? highlightTokens(value, fileType) : jsoncTokens(value), problems), [value, mode, fileType, problems]);
  const offered = useMemo(() => mode === 'text' && focused && !closed ? suggestions(currentStepPrefix(value, cursor), fileType).slice(0, MAX_SUGGESTIONS) : [], [value, cursor, mode, focused, closed, fileType]);
  useEffect(() => { setChoice(0); setNavigated(false); }, [offered.length, value, cursor]);
  useEffect(() => { list.current?.children[choice]?.scrollIntoView({ block: 'nearest' }); }, [choice]);
  // The box grows with its text, so the highlighted copy underneath never has to scroll with it.
  useLayoutEffect(() => {
    const box = area.current;
    if (!box) return;
    box.style.height = '0'; box.style.height = `${box.scrollHeight}px`;
    if (pending.current !== undefined) { box.setSelectionRange(pending.current, pending.current); setCursor(pending.current); pending.current = undefined; }
  });

  const apply = (edit: Edit) => { pending.current = edit.cursor; setClosed(false); onChange(edit.text); };
  const sync = () => setCursor(area.current?.selectionStart ?? 0);
  function pick(index: number) {
    const box = area.current;
    if (!box) return;
    const edit = completeWithTab(value, box.selectionStart, fileType, index);
    if (edit) apply(edit);
    box.focus();
  }
  return <div className={`code ${mode}`}>
    <div className="code-box">
      <pre className="code-highlight" aria-hidden="true">{spans.map((span, i) => <span key={i} className={[span.type && `tok-${span.type}`, span.category && `cat-${span.category}`, span.error && 'err'].filter(Boolean).join(' ') || undefined}>{span.text}</span>)}{'\n'}</pre>
      <textarea ref={area} className="code-input" aria-label={label} spellCheck={false} autoComplete="off" autoCapitalize="off" value={value} placeholder={placeholder} rows={4}
        onFocus={() => { setFocused(true); sync(); }} onBlur={() => setFocused(false)} onClick={sync} onKeyUp={sync} onSelect={sync}
        onChange={event => {
          const box = event.target, next = mode === 'text' ? autoInsertArrow(box.value, box.selectionStart) : undefined;
          apply(next ?? { text: box.value, cursor: box.selectionStart });
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); onSubmit?.(); return; }
          if (mode !== 'text') return;
          if (event.key === 'Escape' && offered.length) { event.preventDefault(); event.stopPropagation(); setClosed(true); }
          else if (event.key === 'ArrowDown' && offered.length) { event.preventDefault(); setNavigated(true); setChoice((choice + 1) % offered.length); }
          else if (event.key === 'ArrowUp' && offered.length) { event.preventDefault(); setNavigated(true); setChoice((choice + offered.length - 1) % offered.length); }
          else if (event.key === 'Tab' && !event.shiftKey && completeWithTab(value, event.currentTarget.selectionStart, fileType)) { event.preventDefault(); pick(choice); }
          else if (event.key === 'Enter' && navigated && offered.length) { event.preventDefault(); pick(choice); }
        }}/>
    </div>
    {offered.length > 0 && <ul ref={list} className="suggestions" role="listbox" aria-label="Suggestions">
      {offered.map((entry, i) => <li key={`${entry.label}-${i}`} role="option" aria-selected={i === choice} className={i === choice ? 'chosen' : undefined}
        onMouseDown={event => { event.preventDefault(); pick(i); }}><b className={`cat-${entry.category}`}>{entry.label}</b><span>{entry.details}</span></li>)}
      <li className="hint" aria-hidden="true">Tab completes. Up and Down choose. Ctrl+Enter saves.</li>
    </ul>}
    {problems.length > 0 && <ul className="problems" role="alert">{problems.map((problem, i) => <li key={i}>
      {problem.line !== undefined && <button type="button" className="where" onClick={() => { const box = area.current; if (box && problem.offset !== undefined) { box.focus(); box.setSelectionRange(problem.offset, problem.offset + Math.max(1, problem.length ?? 1)); } }}>Line {problem.line}, column {problem.column}</button>}
      {problem.message}</li>)}</ul>}
  </div>;
}
