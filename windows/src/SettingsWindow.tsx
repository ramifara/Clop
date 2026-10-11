import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SettingMeta } from '../core/settings/controls';
import { SETTING_ENTRIES, hostRow, settingsTarget, type SettingEntry } from '../core/settings/entries';
import { searchSettings } from '../core/settings/search';
import { SETTINGS_TABS, TAB_GROUPS, TAB_ORDER, type SettingsTab } from '../core/settings/tabs';
import { settingsTab } from '../electron/clop-url';
import { api } from './api';
import { Icon } from './icons';
import { SettingsContext, clean, rowDomId, type SettingsEnv } from './settings/context';
import { EntryRow } from './settings/EntryRow';
import type { AppState, PrefsReply, PrefsRequest } from './types';
import './settings.css';

const TAB_ICONS: Record<SettingsTab, string> = {
  general: 'settings', clipboard: 'clipboard', files: 'folder', video: 'video', audio: 'audio', images: 'image', pdf: 'doc', dropzone: 'drop',
  presetZones: 'grid', floating: 'stack', keys: 'command', pipelines: 'branch', automation: 'hammer', mcp: 'sparkle', updates: 'key', about: 'info',
};

/** The tab and row the window was opened with by `?tab=` and `?highlight=` (and the search by `?search=`) (a `clop://settings/<tab>/<row>` link opened in a browser). */
function targetFromQuery() {
  const query = new URLSearchParams(location.search), tab = query.get('tab');
  return settingsTarget(tab ? settingsTab(tab) : undefined, query.get('highlight') ?? query.get('row') ?? undefined);
}

/** The Settings window: a tab sidebar with search, and the rows of the selected tab drawn from the schema and the row index. */
export function SettingsWindow({ state, refresh }: { state: AppState; refresh(): Promise<void> }) {
  const [metas, setMetas] = useState<ReadonlyMap<string, SettingMeta>>();
  const [target] = useState(targetFromQuery);
  const [tab, setTab] = useState<SettingsTab>(target.tab);
  const [highlight, setHighlight] = useState<string | undefined>(target.row);
  const [flash, setFlash] = useState<string>();
  const [query, setQuery] = useState(() => new URLSearchParams(location.search).get('search') ?? '');
  const [toast, setToast] = useState<{ text: string; error: boolean }>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { api.prefs({ action: 'meta' }).then(reply => setMetas(new Map(reply.meta!.map(meta => [meta.key, meta]))), error => setToast({ text: clean(error), error: true })); }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const say = useCallback((text: string, error = false) => {
    clearTimeout(toastTimer.current); setToast({ text, error });
    toastTimer.current = setTimeout(() => setToast(undefined), error ? 8000 : 4000);
  }, []);
  const run = useCallback(async (task: () => Promise<unknown>, success?: string) => {
    try { await task(); await refresh(); if (success) say(success); return true; } catch (error) { say(clean(error), true); return false; }
  }, [refresh, say]);
  const env = useMemo<SettingsEnv | undefined>(() => metas && ({
    settings: state.settings, metas, native: state.native, platform: state.platform, run,
    change: partial => { void run(() => api.settings(partial)); },
    prefs: async request => { let reply: PrefsReply | undefined; const ok = await run(async () => { reply = await api.prefs(request); }); if (ok && reply?.message) say(reply.message); return ok ? reply : undefined; },
    ask: async (request: PrefsRequest) => api.prefs(request).catch(() => undefined),
  }), [metas, state.settings, state.native, state.platform, run, say]);

  const open = useCallback((next: SettingsTab, row?: string) => { setQuery(''); setTab(next); setHighlight(row); }, []);
  // The tray and `clop://settings/…` links ask through the state, so a window that was still loading gets the request too.
  const nonce = state.settingsRequest?.nonce;
  useEffect(() => { if (state.settingsRequest) open(state.settingsRequest.tab, state.settingsRequest.row); }, [nonce]);
  // Scroll to a row once its tab has drawn, and flash it.
  useEffect(() => {
    if (!highlight || !env) return;
    const entry = SETTING_ENTRIES.find(row => row.id === highlight);
    const id = entry ? hostRow(entry).id : highlight;
    const frame = requestAnimationFrame(() => {
      document.getElementById(rowDomId(id))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFlash(id);
    });
    const timer = setTimeout(() => { setFlash(undefined); setHighlight(undefined); }, 2600);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [highlight, tab, env]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); search.current?.select(); return; }
      if (event.ctrlKey && !event.altKey && /^[1-9]$/.test(event.key)) { event.preventDefault(); open(TAB_ORDER[Number(event.key) - 1]); return; }
      if (event.ctrlKey && event.key === 'Tab') { event.preventDefault(); open(TAB_ORDER[(TAB_ORDER.indexOf(tab) + (event.shiftKey ? -1 : 1) + TAB_ORDER.length) % TAB_ORDER.length]); }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [open, tab]);

  const results = useMemo(() => query.trim() ? searchSettings(query) : undefined, [query]);
  const sections = useMemo(() => {
    const rows = SETTING_ENTRIES.filter(entry => entry.tab === tab), order = [...new Set(rows.map(entry => entry.section))];
    return order.map(section => ({ section, rows: rows.filter(entry => entry.section === section) }));
  }, [tab]);

  return <div className="settings-window">
    <nav className="sidebar" aria-label="Settings">
      <div className="search">
        <Icon name="search" size={13}/>
        <input ref={search} type="search" aria-label="Search settings" placeholder="Search settings" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); if (event.key === 'Enter' && results?.[0]) open(results[0].tab, results[0].id); }}/>
        {query && <button aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" size={10}/></button>}
      </div>
      {results ? <SearchResults results={results} query={query} onOpen={entry => open(entry.tab, entry.id)}/> : <div className="tabs" role="tablist" aria-orientation="vertical">
        {TAB_GROUPS.map(group => <div key={group.title || 'top'} className="tab-group">
          {group.title && <h2>{group.title}</h2>}
          {group.tabs.map(name => <button key={name} role="tab" aria-selected={name === tab} className={name === tab ? 'selected' : ''} onClick={() => open(name)}><Icon name={TAB_ICONS[name]} size={15}/>{SETTINGS_TABS[name]}</button>)}
        </div>)}
      </div>}
    </nav>
    <main className="pane" aria-label={SETTINGS_TABS[tab]}>
      <h1>{SETTINGS_TABS[tab]}</h1>
      {env ? <SettingsContext.Provider value={env}>
        {sections.map(({ section, rows }) => <section key={section || 'main'} aria-label={section || SETTINGS_TABS[tab]}>
          {section && <h2>{section}</h2>}
          <div className="group">{rows.map(entry => <EntryRow key={entry.id} entry={entry} flash={flash === entry.id}/>)}</div>
        </section>)}
      </SettingsContext.Provider> : <p className="loading">Loading…</p>}
    </main>
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.text}<button aria-label="Dismiss" onClick={() => setToast(undefined)}><Icon name="close" size={10}/></button></div>}
  </div>;
}

function SearchResults({ results, query, onOpen }: { results: SettingEntry[]; query: string; onOpen(entry: SettingEntry): void }) {
  if (!results.length) return <p className="no-results">Nothing matches “{query.trim()}”</p>;
  return <ul className="results" aria-label="Search results">{results.map(entry => <li key={entry.id}>
    <button onClick={() => onOpen(entry)}>
      <strong>{entry.title}</strong>
      {entry.subtitle && <small>{entry.subtitle}</small>}
      <span>{[SETTINGS_TABS[entry.tab], entry.section].filter(Boolean).join(' › ')}</span>
    </button>
  </li>)}</ul>;
}
