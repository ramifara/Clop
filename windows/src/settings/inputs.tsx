import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { describeAccelerator, isModifierKey, modifierLabel, recorded, type Modifier } from './accelerator';
import { useSettings } from './context';
import { TEMPLATE_VARIABLES } from './options';

// The inputs the Settings window shares: switches and number boxes that save when you stop typing, the name template field with its
// live preview, the resolution and size ranges, the format picker and the shortcut recorder.

/** A value being edited. It saves a moment after the last change, on Enter or blur, and when the field goes away; until then it is the draft. */
export function useDraft<T>(value: T, commit: (value: T) => void, delay = 500) {
  const [draft, setDraft] = useState(value);
  const state = useRef({ draft: value, dirty: false, commit, timer: undefined as ReturnType<typeof setTimeout> | undefined });
  state.current.commit = commit;
  useEffect(() => { if (!state.current.dirty) { state.current.draft = value; setDraft(value); } }, [value]);
  const flush = useCallback(() => {
    const s = state.current;
    clearTimeout(s.timer);
    if (s.dirty) { s.dirty = false; s.commit(s.draft); }
  }, []);
  const edit = useCallback((next: T) => {
    const s = state.current;
    s.draft = next; s.dirty = true; setDraft(next);
    clearTimeout(s.timer); s.timer = setTimeout(flush, delay);
  }, [delay, flush]);
  const reset = useCallback(() => { const s = state.current; clearTimeout(s.timer); s.dirty = false; s.draft = value; setDraft(value); }, [value]);
  useEffect(() => flush, [flush]);
  return { draft, edit, flush, reset };
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange(checked: boolean): void; label: string; disabled?: boolean }) {
  return <input type="checkbox" role="switch" className="switch" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/>;
}

/** A whole number or decimal. Only a value inside the bounds is saved; anything else outlines the box and the stored value comes back on blur. */
export function NumberField({ value, onCommit, min = 0, max, unit, decimal = false, label, width = 76 }: { value: number; onCommit(value: number): void; min?: number; max?: number; unit?: string; decimal?: boolean; label: string; width?: number }) {
  const { draft, edit, flush, reset } = useDraft(String(value), text => { const n = Number(text); if (valid(text)) onCommit(n); }, 600);
  function valid(text: string) {
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) && (decimal || Number.isInteger(n)) && n >= min && (max === undefined || n <= max);
  }
  return <span className="number-field">
    <input type="number" inputMode="decimal" aria-label={label} style={{ width }} min={min} max={max} step={decimal ? 'any' : 1} value={draft} aria-invalid={!valid(draft)}
      onChange={event => edit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') flush(); }} onBlur={() => { if (valid(draft)) flush(); else reset(); }}/>
    {unit && <span className="unit">{unit}</span>}
  </span>;
}

export function TextField({ value, onCommit, label, placeholder, mono = false }: { value: string; onCommit(value: string): void; label: string; placeholder?: string; mono?: boolean }) {
  const { draft, edit, flush } = useDraft(value, onCommit);
  return <input type="text" className={`text-field ${mono ? 'mono' : ''}`} aria-label={label} placeholder={placeholder} spellCheck={false} value={draft}
    onChange={event => edit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') flush(); }} onBlur={flush}/>;
}

/** `ResolutionField.swift`'s role in the settings window: a pixel size with 0 meaning no limit. */
export function ResolutionField({ label, value, onCommit, min = 0 }: { label: string; value: number; onCommit(value: number): void; min?: number }) {
  return <NumberField label={label} value={value} onCommit={onCommit} min={min} max={100000} unit="px" width={84}/>;
}

/** Chips for a list of file extensions; each one on is in the setting. Extensions the setting already holds that are not offered stay as chips too. */
export function FormatSelect({ options, value, onChange, label }: { options: readonly string[]; value: readonly string[]; onChange(next: string[]): void; label: string }) {
  const all = [...options, ...value.filter(item => !options.includes(item))];
  return <div className="chips" role="group" aria-label={label}>
    {all.map(item => {
      const on = value.includes(item);
      return <button key={item} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => onChange(on ? value.filter(other => other !== item) : [...value, item])}>{item}</button>;
    })}
  </div>;
}

/**
 * A name or path template with what it makes of an example file underneath. The main process expands it with `core/template.ts`, so
 * the preview is what Clop will really name the file.
 */
export function NameTemplateField({ settingKey, value, onCommit, placeholder }: { settingKey: string; value: string; onCommit(value: string): void; placeholder: string }) {
  const { ask } = useSettings();
  const { draft, edit, flush } = useDraft(value, onCommit);
  const [preview, setPreview] = useState<{ input: string; output: string }>();
  const [help, setHelp] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => { ask({ action: 'template', key: settingKey as never, template: draft }).then(reply => { if (live) setPreview(reply?.preview); }); }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [draft, settingKey, ask]);
  function insert(token: string) {
    const field = input.current, start = field?.selectionStart ?? draft.length, end = field?.selectionEnd ?? draft.length;
    edit(draft.slice(0, start) + token + draft.slice(end));
    requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(start + token.length, start + token.length); });
  }
  return <div className="template-field">
    <input ref={input} type="text" className="text-field mono" aria-label="Template" placeholder={placeholder} spellCheck={false} value={draft}
      onChange={event => edit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') flush(); }} onBlur={flush}/>
    <div className="template-preview" aria-live="polite">{preview ? <><span>{preview.input}</span><b aria-hidden>→</b><strong>{preview.output}</strong></> : <span>&nbsp;</span>}</div>
    <button type="button" className="link" aria-expanded={help} onClick={() => setHelp(!help)}>{help ? 'Hide variables' : 'Variables'}</button>
    {help && <div className="chips variables">{TEMPLATE_VARIABLES.map(([token, name]) => <button key={token} type="button" className="chip" title={name} onClick={() => insert(token)}><code>{token}</code> {name}</button>)}</div>}
  </div>;
}

/**
 * Press the shortcut you want. Focus the box, hold the keys, and the shortcut is saved when a key other than a modifier goes down; in
 * `modifiers` mode the modifiers held when the keys are let go are saved instead. Escape cancels.
 */
export function AcceleratorRecorder({ value, mode, onRecord, label }: { value: string; mode: 'shortcut' | 'modifiers'; onRecord(result: { modifiers: Modifier[]; accelerator?: string }): void; label: string }) {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<Modifier[]>([]);
  const peak = useRef<Modifier[]>([]);
  const stop = () => { setRecording(false); setHeld([]); peak.current = []; };
  function down(event: React.KeyboardEvent) {
    if (!recording) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setRecording(true); } return; }
    event.preventDefault();
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) { stop(); return; }
    const result = recorded(event.nativeEvent);
    setHeld(result.modifiers);
    if (result.modifiers.length > peak.current.length) peak.current = result.modifiers;
    if (mode === 'shortcut' && result.accelerator) { onRecord(result); stop(); }
  }
  function up(event: React.KeyboardEvent) {
    if (!recording || mode !== 'modifiers') return;
    event.preventDefault();
    const remaining = recorded(event.nativeEvent).modifiers;
    setHeld(remaining);
    if (!remaining.length && peak.current.length && isModifierKey(event.nativeEvent)) { onRecord({ modifiers: peak.current }); stop(); }
  }
  const shown = recording ? (held.length ? held.map(modifierLabel).join('+') : mode === 'modifiers' ? 'Hold the keys…' : 'Press the shortcut…') : value ? describeAccelerator(value) : 'Not set';
  return <button type="button" className={`recorder ${recording ? 'recording' : ''}`} aria-label={`${label}: ${recording ? 'recording' : value || 'not set'}`} onClick={() => setRecording(!recording)} onKeyDown={down} onKeyUp={up} onBlur={stop}>{shown}</button>;
}

export function Chip({ children, on, onClick, title }: { children: ReactNode; on?: boolean; onClick(): void; title?: string }) {
  return <button type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} title={title} onClick={onClick}>{children}</button>;
}
