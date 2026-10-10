import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api } from './api';
import { Icon } from './icons';
import type { AppEntry, AppState, ClopSettings, ImageOptions, ItemResult } from './types';

const preferences = new URLSearchParams(location.search).has('preferences');
const humanSize = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1000))} KB`;
const pad = (value: number) => String(value).padStart(2, '0');
function duration(ms: number) { const s = Math.round(ms / 1000), h = Math.floor(s / 3600); return h ? `${h}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`; }
const NOUNS = { image: 'image', video: 'video', pdf: 'PDF', audio: 'audio file' } as const;
type Run = (task: () => Promise<unknown>, success?: string) => Promise<void>;

export function App() {
  const [state, setState] = useState<AppState>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [localDrag, setLocalDrag] = useState(false);
  const [selected, setSelected] = useState<string>();
  const notification = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interactive = useRef(false);
  useEffect(() => {
    api.state().then(setState).catch(error => setError(error.message));
    return api.subscribe(setState);
  }, []);
  useEffect(() => { document.documentElement.classList.toggle('browser-preview', state?.native === false); }, [state?.native]);
  useEffect(() => { if (state?.native && !state.dropActive && !state.settings.keepDropZoneVisible) setLocalDrag(false); }, [state?.native, state?.dropActive, state?.settings.keepDropZoneVisible]);
  useEffect(() => () => { if (notification.current) clearTimeout(notification.current); }, []);
  const run: Run = useCallback(async (task, success) => {
    setError('');
    try {
      await task(); setState(await api.state());
      if (success) { setMessage(success); if (notification.current) clearTimeout(notification.current); notification.current = setTimeout(() => setMessage(''), 1600); }
    } catch (error) { setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)); }
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable)) return;
      const item = state?.items.find(item => item.id === selected) ?? state?.items[0];
      if (event.key === 'Escape') { void api.window('hide'); return; }
      if (!item || item.status !== 'ready' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (item.kind === 'image' && /^[1-9]$/.test(event.key)) { event.preventDefault(); void run(() => api.apply(item.id, { ...item.options, scale: Number(event.key) / 10, maxEdge: undefined })); }
      else if (item.kind === 'image' && event.key === '-') { event.preventDefault(); void run(() => api.apply(item.id, { ...item.options, scale: Math.max(.1, Math.round((item.width / item.originalWidth - .1) * 10) / 10), maxEdge: undefined })); }
      else if (event.key.toLowerCase() === 'c') void run(() => api.copy(item.id), 'Copied');
      else if (event.key.toLowerCase() === 'r') void run(() => api.restore(item.id));
    };
    const paste = (event: ClipboardEvent) => {
      if (preferences || (event.target instanceof HTMLElement && event.target.closest('input'))) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length || state?.native) { event.preventDefault(); void run(() => state?.native ? api.clipboard() : api.importFiles(files)); }
    };
    document.addEventListener('keydown', key); document.addEventListener('paste', paste);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('paste', paste); };
  }, [state, selected, run]);
  useEffect(() => {
    if (!state?.native || preferences) return;
    const move = (event: MouseEvent) => {
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('.corner-card,.drop-target,.corner-notice,.stack-actions');
      if (Boolean(hit) !== interactive.current) { interactive.current = Boolean(hit); void api.window(hit ? 'interactive' : 'passthrough'); }
    };
    document.addEventListener('mousemove', move); return () => document.removeEventListener('mousemove', move);
  }, [state?.native]);
  if (!state) return null;
  if (preferences) return <Preferences settings={state.settings} run={run}/>;
  function drop(event: DragEvent) {
    event.preventDefault(); setLocalDrag(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length) void run(() => api.importFiles(files, event.ctrlKey));
    else {
      const url = (event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')).split('\n').find(line => /^https?:\/\//i.test(line.trim()));
      if (url) void run(() => api.importUrl(url.trim(), event.ctrlKey));
    }
  }
  function imageDrag(event: DragEvent) {
    if (state?.native) return Boolean(state.dropActive || state.settings.keepDropZoneVisible) && event.dataTransfer.types.some(type => ['Files', 'text/uri-list', 'text/plain'].includes(type));
    if (!event.dataTransfer.types.includes('Files')) return false;
    return Array.from(event.dataTransfer.items).some(item => /^image\/(png|jpeg|webp|gif|avif|tiff)$/i.test(item.type));
  }
  const items = state.items.slice(0, state.dropActive || state.settings.keepDropZoneVisible || localDrag ? 2 : 3).reverse();
  return <div className={`corner-surface ${state.settings.floatingResultsCorner}`} onDragOver={event => { if (imageDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDragEnter={event => { if (imageDrag(event)) { event.preventDefault(); setLocalDrag(true); } }} onDrop={drop}>
    <div className="corner-stack">
      {(state.dropActive || state.settings.keepDropZoneVisible || localDrag) && <div className={`drop-target ${localDrag ? 'receiving' : ''}`} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setLocalDrag(false); }}><strong>Drop to optimise</strong><div className="drop-ring"><span/><span/><span/></div><small>Images, videos, PDFs, audio</small><small>Originals stay safe</small><small>Ctrl: smaller file</small></div>}
      {items.map(item => <ResultCard key={item.id} item={item} native={state.native} run={run} onSelect={() => setSelected(item.id)}/>)}
      {(error || state.notice) && <div className="corner-notice" role="alert"><span>{error || state.notice}</span><button aria-label="Dismiss message" onClick={() => { setError(''); void api.window('dismiss-notice'); }}><Icon name="close" size={12}/></button></div>}
      {items.length > 1 && <div className="stack-actions"><button onClick={() => void run(() => api.copy(state.items[0].id), 'Copied')}>Copy latest</button><button onClick={() => void run(async () => { for (const item of state.items) await api.dismiss(item.id); })}>Clear all</button></div>}
      {message && <div className="copy-toast" role="status">{message}</div>}
    </div>
  </div>;
}

function ResultCard({ item, native, run, onSelect }: { item: ItemResult; native: boolean; run: Run; onSelect: () => void }) {
  const [panel, setPanel] = useState<'scale' | 'compression' | 'dimensions' | 'menu' | null>(null);
  const [scale, setScale] = useState(Math.round(item.width / item.originalWidth * 100));
  const [edge, setEdge] = useState(Math.max(item.width, item.height).toString());
  const [comparing, setComparing] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const ready = item.status === 'ready', busy = item.status === 'processing', image = item.kind === 'image';
  const saved = Math.min(99.9, Math.round((1 - item.outputBytes / item.originalBytes) * 1000) / 10);
  const expanded = hovering && !collapsed;
  useEffect(() => { setScale(Math.round(item.width / item.originalWidth * 100)); setEdge(Math.max(item.width, item.height).toString()); }, [item.width, item.height, item.originalWidth]);
  const apply = (options: Partial<ImageOptions>) => { setPanel(null); setCollapsed(true); void run(() => api.apply(item.id, { ...item.options, ...options })); };
  function commitScale(value = scale) { apply({ scale: value / 100, maxEdge: undefined }); }
  const restore = { name: 'Restore original', icon: 'restore', action: () => { setCollapsed(true); void run(() => api.restore(item.id)); } };
  const copy = { name: image ? 'Copy image' : 'Copy file', icon: 'copy', action: () => { setCollapsed(true); void run(() => api.copy(item.id), 'Copied'); } };
  const save = { name: image ? 'Save image' : 'Save file', icon: 'down', action: () => void run(() => api.save(item.id)) };
  // Videos, PDFs and audio have no card actions of their own yet.
  const actions = image ? [
    { name: 'Downscale', icon: 'minus', action: () => setPanel('scale') }, restore,
    { name: 'Compression', icon: 'settings', action: () => setPanel('compression') },
    { name: 'Aggressive optimisation', icon: 'bolt', action: () => apply({ mode: 'aggressive' }) }, copy, save,
  ] : [restore, copy, save, ...(native ? [{ name: 'Show in Explorer', icon: 'folder', action: () => void run(() => api.reveal(item.id)) }] : [])];
  const change = saved > 0 && !item.restored ? ` · −${saved}%` : item.restored ? ' · Original' : '';
  const details = [item.kind === 'video' && item.width ? `${item.width}×${item.height}` : '', item.durationMs ? duration(item.durationMs) : '', item.pages ? `${item.pages} page${item.pages === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  return <article className={`corner-card ${expanded || panel ? 'expanded' : ''} ${busy ? 'processing' : ''}`} aria-label={`Optimised ${item.name}`} onPointerEnter={() => { setHovering(true); setCollapsed(false); onSelect(); }} onPointerLeave={() => { setHovering(false); setPanel(null); setComparing(false); }} onFocus={onSelect}>
    <div className="thumbnail" draggable={native && ready && !panel} onDragStart={event => { event.preventDefault(); if (native && ready && !panel) api.drag(item.id); }} onDoubleClick={() => { if (ready && native) void run(() => api.reveal(item.id)); }}>
      <img src={comparing ? item.originalPreview : item.preview} alt={item.name} draggable={false}/><div className="thumbnail-shade"/><div className="hover-glass"/>
    </div>
    <div className="window-grip" title="Move result"/>
    <div className="card-corners"><button className="corner-button close" aria-label={`Dismiss ${NOUNS[item.kind]}`} title="Dismiss" disabled={busy} onClick={() => void run(() => api.dismiss(item.id))}><Icon name="close" size={10}/></button><button className="corner-button more" aria-label="More actions" title="More actions" disabled={busy} onClick={() => setPanel(panel === 'menu' ? null : 'menu')}>•••</button></div>
    {panel === 'scale' ? <div className="card-panel scale-panel"><button className="panel-close" aria-label="Close downscale" onClick={() => setPanel(null)}><Icon name="close" size={10}/></button><strong>{scale}% · {Math.round(item.originalWidth * scale / 100)}×{Math.round(item.originalHeight * scale / 100)}</strong><input autoFocus type="range" aria-label="Downscale" min="10" max="100" step="5" value={scale} onChange={event => setScale(Number(event.target.value))} onPointerUp={event => commitScale(Number(event.currentTarget.value))} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) commitScale(Number(event.currentTarget.value)); }}/><div className="scale-presets">{[100, 75, 50, 25, 10].map(value => <button key={value} disabled={busy} onClick={() => commitScale(value)}>{value}%</button>)}</div></div>
    : panel === 'compression' ? <div className="card-panel compression-panel"><strong>Compression</strong>{(['balanced', 'aggressive', 'lossless'] as const).map(mode => <button key={mode} className={mode === item.options.mode ? 'active' : ''} onClick={() => apply({ mode })}>{mode === 'balanced' ? 'Balanced' : mode === 'aggressive' ? 'Smaller' : 'Lossless'}</button>)}</div>
    : panel === 'dimensions' ? <form className="card-panel dimension-panel" onSubmit={event => { event.preventDefault(); apply({ maxEdge: Number(edge), scale: 1 }); }}><label htmlFor={`edge-${item.id}`}>Longest edge</label><div><input id={`edge-${item.id}`} autoFocus type="number" min="1" max="16000" value={edge} onChange={event => setEdge(event.target.value)}/><span>px</span><button type="submit" aria-label="Apply dimensions"><Icon name="check" size={14}/></button></div></form>
    : panel === 'menu' ? <div className="card-panel action-menu">{image && <><button onClick={() => { setPanel(null); setComparing(true); }}>Compare original</button><button onClick={() => setPanel('dimensions')}>Set dimensions…</button></>}<button onClick={() => void run(() => api.save(item.id))}>Save as…</button>{native && <button onClick={() => void run(() => api.reveal(item.id))}>Show in Explorer</button>}</div>
    : !busy && !item.error && <div className="action-grid" aria-label={`${NOUNS[item.kind]} actions`}>{actions.map(action => <button key={action.name} className="grid-button" aria-label={action.name} title={action.name} onPointerDown={event => { if (action.name === 'Downscale') { event.preventDefault(); setPanel('scale'); } }} onClick={action.action}><Icon name={action.icon} size={17}/></button>)}</div>}
    <div className="card-bottom">
      {busy ? <div className="card-progress"><span className="spinner"/>Optimising…{item.progress ? ` ${Math.round(item.progress * 100)}%` : ''}</div> : item.error ? <div className="card-error" role="alert">{item.error}<button onClick={() => void run(() => api.restore(item.id))}>Restore original</button></div> : panel ? null : <>
        <div className="size-diff"><span className={item.outputBytes < item.originalBytes ? 'old' : ''}>{humanSize(item.originalBytes)}</span>{item.outputBytes !== item.originalBytes && <><Icon name="arrow" size={11}/><strong className={saved < 0 ? 'larger' : ''}>{humanSize(item.outputBytes)}</strong></>}</div>
        {image ? <button className="resolution-chip" aria-label="Set dimensions" title="Set dimensions" disabled={busy} onClick={() => setPanel('dimensions')}>{item.width}×{item.height}{change}</button>
          : <span className="resolution-chip">{details}{details ? change : change.slice(3)}</span>}
        <span className="filename-chip" title={item.name}>{item.name.replace(/\.[^.]+$/, '')}</span>
      </>}
    </div>
    {image ? <div className="format-bar" role="group" aria-label="Image format">{(['png', 'jpeg', 'webp', 'avif', 'gif'] as const).map(format => <button key={format} disabled={busy || (item.animated && !['gif', 'webp'].includes(format))} aria-label={`Convert to ${format === 'jpeg' ? 'JPEG' : format.toUpperCase()}`} aria-pressed={item.format === format} className={item.format === format ? 'active' : ''} onClick={() => apply({ format })}>{format === 'jpeg' ? 'JPG' : format.toUpperCase()}</button>)}</div>
      : <div className="format-bar kind-bar" aria-label="File type">{item.format.toUpperCase()}</div>}
  </article>;
}

type Toggle = { [K in keyof ClopSettings]: ClopSettings[K] extends boolean ? K : never }[keyof ClopSettings];
function Preferences({ settings, run }: { settings: ClopSettings; run: Run }) {
  function toggle(key: Toggle, title: string) { return <label className="preference-row" key={key}><span>{title}</span><input type="checkbox" checked={Boolean(settings[key])} onChange={event => void run(() => api.settings({ [key]: event.target.checked }))}/></label>; }
  return <div className="preferences"><h1>Clop settings</h1>{toggle('enableClipboardOptimiser', 'Automatically optimise the clipboard')}{toggle('optimiseImagePathClipboard', 'Also optimise copied image files and paths')}{toggle('optimiseVideoClipboard', 'Optimise copied videos')}{toggle('optimisePDFClipboard', 'Optimise copied PDFs')}{toggle('optimiseAudioClipboard', 'Optimise copied audio files')}{toggle('autoCopyToClipboard', 'Copy results of drops to the clipboard')}{toggle('enableDragAndDrop', 'Show drop target while dragging')}{toggle('keepDropZoneVisible', 'Keep drop target visible')}{toggle('floatingResultsAlwaysOnTop', 'Keep results above other windows')}{toggle('launchAtLogin', 'Start with Windows')}<IgnoredApps ignored={settings.clipboardIgnoredAppBundleIds} run={run}/><label className="preference-row"><span>Position</span><select value={settings.floatingResultsCorner} onChange={event => void run(() => api.settings({ floatingResultsCorner: event.target.value as ClopSettings['floatingResultsCorner'] }))}>{['bottomRight', 'bottomLeft', 'topRight', 'topLeft'].map(corner => <option key={corner} value={corner}>{corner.replace(/[A-Z]/, letter => ` ${letter.toLowerCase()}`)}</option>)}</select></label><label className="preference-row"><span>Default format</span><select value={settings.defaultImageFormat} onChange={event => void run(() => api.settings({ defaultImageFormat: event.target.value as ClopSettings['defaultImageFormat'] }))}><option value="auto">Keep original format</option>{['png', 'jpeg', 'webp', 'avif', 'gif'].map(format => <option key={format} value={format}>{format.toUpperCase()}</option>)}</select></label><p>Ctrl+Shift+C optimises the clipboard.<br/>Ctrl+Shift+Space shows the latest result.<br/>1–9 downscale; C copies; R restores.</p></div>;
}

/** The ignored-apps picker: running apps and Start Menu apps, refreshed whenever the settings window shows. */
function IgnoredApps({ ignored, run }: { ignored: string[]; run: Run }) {
  const [apps, setApps] = useState<AppEntry[]>();
  useEffect(() => {
    const load = () => { if (document.visibilityState === 'visible') api.apps().then(setApps, () => setApps([])); };
    load(); document.addEventListener('visibilitychange', load);
    return () => document.removeEventListener('visibilitychange', load);
  }, []);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const name = (entry: string) => apps?.find(app => same(app.path, entry))?.name ?? entry.split(/[\\/]/).pop();
  const save = (list: string[]) => void run(() => api.settings({ clipboardIgnoredAppBundleIds: list }));
  return <div className="ignored-apps"><span>Ignore copies from these apps</span>
    {ignored.length ? <ul>{ignored.map(entry => <li key={entry} title={entry}><span>{name(entry)}</span><button aria-label={`Stop ignoring ${name(entry)}`} onClick={() => save(ignored.filter(other => other !== entry))}><Icon name="close" size={9}/></button></li>)}</ul> : <small>None: copies from every app are optimised.</small>}
    <select aria-label="Ignore an app" value="" onChange={event => { if (event.target.value) save([...ignored, event.target.value]); }}><option value="">{apps ? 'Add an app…' : 'Loading apps…'}</option>{apps?.filter(app => !ignored.some(entry => same(entry, app.path))).map(app => <option key={app.path} value={app.path} title={app.path}>{app.running ? `${app.name} (running)` : app.name}</option>)}</select>
  </div>;
}
