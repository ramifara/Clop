import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Attachments } from './editor/Attachments';
import { Library } from './editor/Library';
import { Zones } from './editor/Zones';
import type { Send } from './editor/types';
import type { EditorState } from './types';
import './editor.css';

type Tab = 'pipelines' | 'attached' | 'zones';
const TABS: [Tab, string][] = [['pipelines', 'Pipelines'], ['attached', 'Attached'], ['zones', 'Preset zones']];
const clean = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);

/** The pipeline editor window (spec step 22): the library with its text and JSON editors, what is attached where, and the preset zones. */
export function Editor() {
  const [state, setState] = useState<EditorState>(), [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>(new URLSearchParams(location.search).get('tab') === 'zones' ? 'zones' : 'pipelines');
  const refresh = useCallback(() => api.editor.state().then(setState, reason => setError(clean(reason))), []);
  useEffect(() => { void refresh(); return api.editor.subscribe(event => { if (event === 'zones') setTab('zones'); else void refresh(); }); }, [refresh]);
  const send: Send = useCallback(async command => {
    setError('');
    try { const reply = await api.editor.command(command); setState(reply.state); if (reply.issues?.length && command.type !== 'pipeline-save' && command.type !== 'pipeline-fix') setError(reply.issues.map(issue => issue.message).join(' ')); return reply; }
    catch (reason) { setError(clean(reason)); }
  }, []);
  if (!state) return <div className="editor"><p className="loading">{error || 'Loading…'}</p></div>;
  return <div className="editor">
    <nav className="tabs" role="tablist" aria-label="Pipeline editor">{TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {error && <div className="banner" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss message" onClick={() => setError('')}>×</button></div>}
    <main>{tab === 'pipelines' ? <Library state={state} send={send}/> : tab === 'attached' ? <Attachments state={state} send={send}/> : <Zones state={state} send={send}/>}</main>
  </div>;
}
