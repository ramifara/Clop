import { useEffect, useMemo, useState } from 'react';
import { stepsToJsonc, parseJsoncSteps } from '../../core/pipeline/jsonc';
import { canFormat, formatSteps, parsePipelineText } from '../../core/pipeline/parser';
import { FILE_TYPES, type ClopFileType } from '../../core/pipeline/model';
import type { EditorState, PipelineView, UnreadableView } from '../../core/pipeline/editor-state';
import { StepTextEditor, type Problem } from './StepTextEditor';
import { ICON_NAMES, glyph } from './glyphs';
import type { Send } from './types';

export const TYPE_NAMES: Record<ClopFileType, string> = { image: 'Image', video: 'Video', pdf: 'PDF', audio: 'Audio' };
const NEW = 'new';

interface Draft { id?: string; /** The revision of the stored entry this draft was made from. */ base?: string; name: string; fileType?: ClopFileType; icon: string; details: string; skipOptimisation: boolean; hideResult: boolean; view: 'text' | 'json'; text: string }
/** The JSON being fixed for an unreadable entry: what it held and its revision when opened, and what the user has typed since. */
interface FixDraft { key: string; raw: string; revision: string; json: string }
const fixOf = (entry: UnreadableView): FixDraft => ({ key: entry.key, raw: entry.raw, revision: entry.revision, json: entry.raw });
const blank = (): Draft => ({ name: '', icon: 'wand.and.sparkles', details: '', skipOptimisation: false, hideResult: false, view: 'text', text: '' });
function draftOf(pipeline: PipelineView): Draft {
  const view = pipeline.exact ? 'text' : 'json';
  return { id: pipeline.key, base: pipeline.revision, name: pipeline.name, fileType: pipeline.fileType, icon: pipeline.icon ?? 'wand.and.sparkles', details: pipeline.details ?? '', skipOptimisation: pipeline.skipOptimisation, hideResult: pipeline.hideResult, view, text: view === 'text' ? pipeline.text : pipeline.json };
}
/** What the parser says about the draft's text, as the problems to underline. */
function problemsIn(draft: Draft): Problem[] {
  if (!draft.text.trim()) return [];
  return (draft.view === 'text' ? parsePipelineText(draft.text, { fileType: draft.fileType }) : parseJsoncSteps(draft.text, { fileType: draft.fileType })).issues;
}

/** Where a pipeline is attached, for the line under its name. */
function usedBy(state: EditorState, id: string): string[] {
  const places = FILE_TYPES.flatMap(kind => state.attachments[kind].filter(source => source.entries.some(entry => entry.libraryID === id)).map(source => `${source.label} (${kind})`));
  return [...places, ...state.zones.filter(zone => zone.libraryID === id).map(zone => `Preset zone ${zone.name}`)];
}

export function Library({ state, send }: { state: EditorState; send: Send }) {
  const [selected, setSelected] = useState<string>(), [draft, setDraft] = useState<Draft>(blank), [saved, setSaved] = useState(() => JSON.stringify(blank())), [filter, setFilter] = useState(''), [note, setNote] = useState(''), [confirming, setConfirming] = useState(false);
  const [serverProblems, setServerProblems] = useState<Problem[]>([]);
  const [fix, setFix] = useState<FixDraft>();
  const entry = state.library.find(candidate => candidate.key === selected);
  const dirty = JSON.stringify(draft) !== saved || (fix !== undefined && fix.json !== fix.raw);
  const problems = useMemo(() => [...problemsIn(draft), ...serverProblems], [draft, serverProblems]);
  const shown = useMemo(() => state.library.filter(candidate => !filter.trim() || (candidate.readable ? candidate.name : candidate.id ?? 'unreadable').toLowerCase().includes(filter.trim().toLowerCase())), [state.library, filter]);

  function open(next: string | undefined, from?: Draft) {
    if (dirty && !window.confirm('Discard the changes to this pipeline?')) return;
    const found = state.library.find(candidate => candidate.key === next);
    const base = from ?? (found?.readable ? draftOf(found) : blank());
    setSelected(next); setDraft(base); setSaved(JSON.stringify(base)); setNote(''); setServerProblems([]); setConfirming(false);
    setFix(found && !found.readable ? fixOf(found) : undefined);
  }
  const edit = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setServerProblems([]); setNote(''); };

  function switchView(view: 'text' | 'json') {
    if (view === draft.view) return;
    if (!draft.text.trim()) { edit({ view }); return; }
    const parsed = draft.view === 'text' ? parsePipelineText(draft.text, { fileType: draft.fileType }) : parseJsoncSteps(draft.text, { fileType: draft.fileType });
    if (parsed.issues.length) { setNote(`Fix the problems in the ${draft.view === 'text' ? 'text' : 'JSON'} before switching views.`); return; }
    if (view === 'json') edit({ view, text: stepsToJsonc(parsed.steps) });
    else if (!parsed.steps.every(canFormat)) setNote('Some steps have no exact text form, so they can only be edited as JSON.');
    else edit({ view, text: formatSteps(parsed.steps) });
  }
  async function save() {
    const reply = await send({ type: 'pipeline-save', id: draft.id, base: draft.base, name: draft.name, fileType: draft.fileType, icon: draft.icon, details: draft.details, skipOptimisation: draft.skipOptimisation, hideResult: draft.hideResult, view: draft.view, text: draft.text });
    if (!reply) return;
    if (reply.issues) { setServerProblems(reply.issues); return; }
    const next = reply.state.library.find(candidate => candidate.key === reply.saved);
    setSelected(reply.saved);
    if (next?.readable) { const base = { ...draft, id: next.key, base: next.revision }; setDraft(base); setSaved(JSON.stringify(base)); }
    setNote('Saved.');
  }
  async function remove() {
    if (!selected || !entry) return;
    const reply = await send({ type: 'pipeline-delete', key: selected, base: entry.revision });
    if (!reply || reply.issues) return;
    setConfirming(false); setSelected(undefined); setDraft(blank()); setSaved(JSON.stringify(blank()));
    const gone = reply.removed ? [reply.removed.attachments && `${reply.removed.attachments} attachment${reply.removed.attachments === 1 ? '' : 's'}`, reply.removed.zones && `${reply.removed.zones} preset zone${reply.removed.zones === 1 ? '' : 's'}`].filter(Boolean) : [];
    setNote(gone.length ? `Deleted, with ${gone.join(' and ')} that used it.` : 'Deleted.');
  }
  // Another writer (the CLI, the MCP server, another window) can change or delete the open entry while it is being edited.
  const stored = entry?.readable ? entry : undefined, mine = stored !== undefined && draft.id === stored.key;
  const changedElsewhere = mine && draft.base !== stored.revision;
  const gone = selected !== undefined && selected !== NEW && !entry;
  useEffect(() => {
    if (changedElsewhere && JSON.stringify(draft) === saved) { const base = draftOf(stored); setDraft(base); setSaved(JSON.stringify(base)); }
    else if (gone && !dirty) { setSelected(undefined); setFix(undefined); setNote('That pipeline was changed or removed elsewhere.'); }
  }, [changedElsewhere, gone, dirty, draft, saved, stored]);
  const conflict = changedElsewhere && dirty;
  const canSave = dirty && !conflict && !!draft.name.trim() && !!draft.text.trim() && !problems.length;
  const uses = selected ? usedBy(state, selected) : [];
  const editing = selected === NEW || entry?.readable || (gone && draft.id === selected);

  return <div className="library">
    <aside className="library-list">
      <div className="list-head"><input type="search" aria-label="Filter pipelines" placeholder="Filter" value={filter} onChange={event => setFilter(event.target.value)}/><button type="button" className="primary" onClick={() => open(NEW, blank())}>New</button></div>
      <ul aria-label="Saved pipelines">
        {shown.map(candidate => <li key={candidate.key}><button type="button" className={candidate.key === selected ? 'row active' : 'row'} aria-current={candidate.key === selected} onClick={() => open(candidate.key)}>
          <span className="glyph" aria-hidden="true">{glyph(candidate.readable ? candidate.icon : undefined)}</span>
          <span className="row-name">{candidate.readable ? candidate.name || 'Unnamed pipeline' : candidate.id ?? 'Unreadable pipeline'}</span>
          {candidate.readable && candidate.fileType && <span className="chip">{TYPE_NAMES[candidate.fileType]}</span>}
          {candidate.readable && candidate.builtin && <span className="badge builtin">Built-in</span>}
          {!candidate.readable && <span className="badge warn">Unreadable</span>}
        </button></li>)}
        {!shown.length && <li className="empty">{state.library.length ? 'No pipeline matches.' : 'No saved pipelines yet.'}</li>}
      </ul>
    </aside>
    <section className="library-pane">
      {!selected && <div className="placeholder"><h2>Pipelines</h2><p>A pipeline is a list of steps, such as <code>downscale(factor: 0.5) -&gt; convert(to: webp)</code>. Pick one to edit it, or press New. Attach pipelines to the clipboard, the drop zone or a watched folder in the Attached tab.</p></div>}
      {entry && !entry.readable && fix?.key === entry.key && <UnreadableEditor key={entry.key} entry={entry} fix={fix} setFix={setFix} send={send} onDone={() => { setFix(undefined); setSelected(undefined); }}/>}
      {gone && <p className="conflict" role="alert">This pipeline was changed or removed elsewhere.{' '}
        {draft.id === selected && <button type="button" onClick={() => { setSelected(NEW); setDraft({ ...draft, id: undefined, base: undefined }); setServerProblems([]); }}>Keep mine as a new pipeline</button>}
        <button type="button" onClick={() => { setSelected(undefined); setDraft(blank()); setSaved(JSON.stringify(blank())); setFix(undefined); }}>Discard</button></p>}
      {conflict && <p className="conflict" role="alert">This pipeline was changed elsewhere while you edited it.{' '}
        <button type="button" onClick={() => { const base = draftOf(stored); setDraft(base); setSaved(JSON.stringify(base)); setServerProblems([]); setNote(''); }}>Load the current version</button>
        <button type="button" onClick={() => { setDraft({ ...draft, base: stored.revision }); setServerProblems([]); }}>Overwrite with mine</button></p>}
      {editing && <>
        <header className="pane-head">
          <label className="icon-pick" title="Icon"><span className="glyph big" aria-hidden="true">{glyph(draft.icon)}</span>
            <select aria-label="Icon" value={ICON_NAMES.includes(draft.icon) ? draft.icon : ''} onChange={event => event.target.value && edit({ icon: event.target.value })}>
              {!ICON_NAMES.includes(draft.icon) && <option value="">{draft.icon}</option>}{ICON_NAMES.map(name => <option key={name} value={name}>{glyph(name)} {name}</option>)}</select></label>
          <input className="name" aria-label="Name" placeholder="Name" maxLength={80} value={draft.name} onChange={event => edit({ name: event.target.value })}/>
          <select aria-label="File type" value={draft.fileType ?? ''} onChange={event => edit({ fileType: (event.target.value || undefined) as ClopFileType | undefined })}>
            <option value="">Any file type</option>{FILE_TYPES.map(kind => <option key={kind} value={kind}>{TYPE_NAMES[kind]} files</option>)}</select>
          {entry?.readable && entry.builtin && <span className="badge builtin">Built-in</span>}
        </header>
        <input className="details" aria-label="Description" placeholder="Description (optional)" maxLength={300} value={draft.details} onChange={event => edit({ details: event.target.value })}/>
        <div className="flags">
          <label title="Start from the original file instead of Clop's optimised copy."><input type="checkbox" checked={draft.skipOptimisation} onChange={event => edit({ skipOptimisation: event.target.checked })}/> Start from the original file</label>
          <label title="Keep the result out of the floating results."><input type="checkbox" checked={draft.hideResult} onChange={event => edit({ hideResult: event.target.checked })}/> Hide the floating result</label>
          <div className="views" role="group" aria-label="View">{(['text', 'json'] as const).map(view => <button key={view} type="button" aria-pressed={draft.view === view} className={draft.view === view ? 'active' : undefined} onClick={() => switchView(view)}>{view === 'text' ? 'Text' : 'JSON'}</button>)}</div>
        </div>
        {draft.view === 'json' && <p className="explain">The steps as JSON, one per line, with <code>//</code> comments allowed. Steps that have no exact text form can only be edited here.</p>}
        <StepTextEditor value={draft.text} onChange={text => edit({ text })} onSubmit={() => { if (canSave) void save(); }} fileType={draft.fileType} mode={draft.view} problems={problems}
          label={draft.view === 'text' ? 'Pipeline steps' : 'Pipeline steps as JSON'} placeholder={draft.view === 'text' ? 'optimise, crop, copy, convert…  Steps are joined with ->' : '[\n  {"optimise": {}}\n]'}/>
        {entry?.readable && entry.problems.length > 0 && <ul className="warnings" aria-label="Stored problems">{entry.problems.map(message => <li key={message}>{message}</li>)}</ul>}
        {uses.length > 0 && <p className="uses">Used by: {uses.join(', ')}</p>}
        <footer className="pane-foot">
          <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>Save</button>
          <button type="button" disabled={!dirty} onClick={() => { const base = entry?.readable ? draftOf(entry) : blank(); setDraft(base); setSaved(JSON.stringify(base)); setServerProblems([]); setNote(''); }}>Revert</button>
          {draft.id && !gone && (confirming ? <span className="confirm">Delete {draft.name || 'this pipeline'}?{uses.length > 0 && ` It is used by ${uses.length} place${uses.length === 1 ? '' : 's'}, which stop using it.`} <button type="button" className="danger" onClick={() => void remove()}>Delete</button><button type="button" onClick={() => setConfirming(false)}>Keep</button></span>
            : <button type="button" className="danger" onClick={() => setConfirming(true)}>Delete…</button>)}
          <span className="note" role="status">{note}</span>
        </footer>
      </>}
    </section>
  </div>;
}

/**
 * An entry this version cannot read: its JSON can be fixed here, or it can be removed. It is kept as it is until then. The
 * typed JSON belongs to this one entry (the editor is keyed by it) and counts as unsaved changes. If the entry changes
 * elsewhere meanwhile, untouched JSON follows it; typed JSON stays and is flagged until the user reloads or overwrites.
 */
function UnreadableEditor({ entry, fix, setFix, send, onDone }: { entry: UnreadableView; fix: FixDraft; setFix: (fix: FixDraft) => void; send: Send; onDone: () => void }) {
  const [problems, setProblems] = useState<Problem[]>([]);
  const stale = entry.revision !== fix.revision, typed = fix.json !== fix.raw;
  useEffect(() => { if (stale && !typed) setFix(fixOf(entry)); }, [stale, typed, entry, setFix]);
  const conflict = stale && typed;
  return <>
    <header className="pane-head"><span className="glyph big" aria-hidden="true">⚠</span><strong>{entry.id ?? 'Unreadable pipeline'}</strong><span className="badge warn">Unreadable</span></header>
    <p className="explain">Clop cannot read this pipeline: {entry.reason} It is kept exactly as it is, so it still works on the Mac it came from. Fix its JSON below to use it here (comments and trailing commas are fine), or delete it.</p>
    {conflict && <p className="conflict" role="alert">This pipeline was changed elsewhere while you edited it. <button type="button" onClick={() => setFix(fixOf(entry))}>Load the current JSON</button> <button type="button" onClick={() => setFix({ ...fix, raw: entry.raw, revision: entry.revision })}>Keep mine</button></p>}
    <StepTextEditor value={fix.json} onChange={value => { setFix({ ...fix, json: value }); setProblems([]); }} mode="json" problems={problems} label="Pipeline JSON"/>
    <footer className="pane-foot">
      <button type="button" className="primary" disabled={conflict} onClick={() => void send({ type: 'pipeline-fix', key: entry.key, base: fix.revision, json: fix.json }).then(reply => { if (reply?.issues) setProblems(reply.issues); else if (reply) onDone(); })}>Use this JSON</button>
      <button type="button" className="danger" onClick={() => void send({ type: 'pipeline-delete', key: entry.key, base: fix.revision }).then(reply => { if (reply && !reply.issues) onDone(); })}>Delete</button>
    </footer>
  </>;
}
