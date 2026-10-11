import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ACTION_KINDS, itemMenu, submenu, batchMenu, SHORTCUTS, type Invocation, type MenuNode } from '../core/cards/actions';
import { api, errorText } from './api';
import { ResultCard, type OpenMenu } from './Cards';
import { keptSize } from './crop-geometry';
import { CompactList } from './Compact';
import { factsFor, toastFor, type Run } from './results';
import { Icon } from './icons';
import { SettingsWindow } from './SettingsWindow';
import { TILE, cellCount, gridHeight, tileAt, tileOrigin } from '../core/pipeline/zones';
import { glyph } from './editor/glyphs';
import { MenuPopup, MenuView } from './Menu';
import type { AppState, PresetTiles } from './types';

const preferences = new URLSearchParams(location.search).has('preferences');

export function App() {
  const [state, setState] = useState<AppState>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [localDrag, setLocalDrag] = useState(false);
  const [selected, setSelected] = useState<string>();
  // Ctrl or Alt held over a drag inside this window, for the browser preview: the app learns it from the Windows helper instead.
  const [heldKeys, setHeldKeys] = useState(false), [pinned, setPinned] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [popup, setPopup] = useState<{ nodes: MenuNode[]; ids: string[]; x: number; y: number }>();
  const notification = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interactive = useRef(false);
  useEffect(() => {
    api.state().then(setState).catch(error => setError(error.message));
    return api.subscribe(setState);
  }, []);
  useEffect(() => { document.documentElement.classList.toggle('browser-preview', state?.native === false); }, [state?.native]);
  useEffect(() => { if (state?.native && !state.dropActive && !state.settings.keepDropZoneVisible) setLocalDrag(false); }, [state?.native, state?.dropActive, state?.settings.keepDropZoneVisible]);
  const targetShown = Boolean(state && (state.dropActive || state.settings.keepDropZoneVisible || localDrag));
  // The tiles stay once the pointer is on them, so letting go of Ctrl or Alt to drop does not take them away.
  useEffect(() => { if (!targetShown) { setPinned(false); setHeldKeys(false); } }, [targetShown]);
  useEffect(() => () => { if (notification.current) clearTimeout(notification.current); }, []);
  const run: Run = useCallback(async (task, success) => {
    setError('');
    try {
      await task(); setState(await api.state());
      if (success) { setMessage(success); if (notification.current) clearTimeout(notification.current); notification.current = setTimeout(() => setMessage(''), 1600); }
    } catch (error) { setError(errorText(error)); }
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable)) return;
      // The settings window has no results to act on: its keys are its own.
      if (preferences) { if (event.key === 'Escape') void api.window('hide'); return; }
      if (event.key === 'Escape') { if (popup) setPopup(undefined); else if (selection.length) setSelection([]); else void api.window('hide'); return; }
      const item = state?.items.find(item => item.id === selected) ?? state?.items[0];
      if (!item || item.status !== 'ready' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (item.kind === 'image' && /^[1-9]$/.test(event.key)) { event.preventDefault(); void run(() => api.apply(item.id, { ...item.options, scale: Number(event.key) / 10, maxEdge: undefined })); return; }
      if (item.kind === 'image' && event.key === '-') { event.preventDefault(); void run(() => api.apply(item.id, { ...item.options, scale: Math.max(.1, Math.round((item.width / keptSize(item.options.crop, item.originalWidth, item.originalHeight).width - .1) * 10) / 10), maxEdge: undefined })); return; }
      // The keys the menu's hints show, on the card under the pointer (or the whole selection).
      const invocation = SHORTCUTS[event.key.length === 1 ? event.key.toLowerCase() : event.key];
      if (!invocation || !ACTION_KINDS[invocation.action].includes(item.kind)) return;
      const ids = selection.length > 1 && selection.includes(item.id) ? selection : [item.id];
      if (ids.length > 1 && !['saveAs', 'copy', 'restore', 'dismiss'].includes(invocation.action)) return;
      event.preventDefault();
      void run(() => api.cardAction(ids, invocation), toastFor(invocation.action));
    };
    const paste = (event: ClipboardEvent) => {
      if (preferences || (event.target instanceof HTMLElement && event.target.closest('input'))) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length || state?.native) { event.preventDefault(); void run(() => state?.native ? api.clipboard() : api.importFiles(files)); }
    };
    document.addEventListener('keydown', key); document.addEventListener('paste', paste);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('paste', paste); };
  }, [state, selected, selection, popup, run]);
  useEffect(() => {
    if (!state?.native || preferences) return;
    const move = (event: MouseEvent) => {
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('.corner-card,.drop-target,.preset-grid,.corner-notice,.stack-actions,.compact-list,.menu-popup');
      if (Boolean(hit) !== interactive.current) { interactive.current = Boolean(hit); void api.window(hit ? 'interactive' : 'passthrough'); }
    };
    document.addEventListener('mousemove', move); return () => document.removeEventListener('mousemove', move);
  }, [state?.native]);
  if (!state) return null;
  if (preferences) return <SettingsWindow state={state} refresh={async () => setState(await api.state())}/>;
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
  const compact = Boolean(state.layout?.compact);
  const cards = state.items.slice(0, state.layout?.cards ?? (targetShown ? 2 : 3)).reverse();
  /** Opens the right-click menu of results (or one of its submenus): native in the app, HTML in the browser preview. */
  const openMenu: OpenMenu = (ids, name, at) => {
    setError('');
    if (state.native) { void run(() => api.cardMenu(ids, name)); return; }
    const items = ids.flatMap(id => state.items.find(item => item.id === id) ?? []);
    if (!items.length) return;
    const facts = factsFor(state, items[0]);
    const nodes = items.length > 1 ? batchMenu(items) : name ? submenu(name, items[0], facts) : itemMenu(items[0], facts);
    setPopup({ nodes, ids, ...at });
  };
  const invoke = (invocation: Invocation) => { const ids = popup?.ids ?? []; setPopup(undefined); setSelection([]); void run(() => api.cardAction(ids, invocation), toastFor(invocation.action)); };
  const revealed = targetShown && (pinned || (state.native ? Boolean(state.presets?.revealed) : heldKeys)) && state.presets;
  const tiles = revealed ? <PresetGrid presets={state.presets!} run={run} onPin={setPinned}/> : null, tilesFirst = state.settings.floatingResultsCorner.startsWith('bottom');
  return <div className={`corner-surface ${state.settings.floatingResultsCorner} ${compact ? 'compact' : ''}`} onDragOver={event => { setHeldKeys(event.ctrlKey || event.altKey); if (imageDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDragEnter={event => { if (imageDrag(event)) { event.preventDefault(); setLocalDrag(true); } }} onDrop={drop}>
    <div className="corner-stack">
      {tilesFirst && tiles}
      {targetShown && <div className={`drop-target ${localDrag ? 'receiving' : ''}`} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setLocalDrag(false); }}><strong>Drop to optimise</strong><div className="drop-ring"><span/><span/><span/></div><small>Images, videos, PDFs, audio</small><small>Originals stay safe</small><small>Ctrl: smaller file</small></div>}
      {!tilesFirst && tiles}
      {compact ? <CompactList state={state} run={run} selection={selection} onSelection={setSelection} onMenu={openMenu} onSelect={setSelected}/>
        : cards.map(item => <ResultCard key={item.id} item={item} state={state} run={run} onSelect={() => setSelected(item.id)} onMenu={openMenu}/>)}
      {(error || state.notice) && <div className="corner-notice" role="alert"><span>{error || state.notice}</span><button aria-label="Dismiss message" onClick={() => { setError(''); void api.window('dismiss-notice'); }}><Icon name="close" size={12}/></button></div>}
      {!compact && state.items.length > 1 && state.settings.showCopyClearButtons && <div className="stack-actions"><button onClick={() => void run(() => api.copy(state.items[0].id), 'Copied')}>Copy latest</button><button onClick={() => void run(async () => { for (const item of state.items) await api.dismiss(item.id); })}>Clear all</button></div>}
      {message && <div className="copy-toast" role="status">{message}</div>}
    </div>
    {popup && <MenuPopup at={{ x: popup.x, y: popup.y }}><MenuView nodes={popup.nodes} onInvoke={invoke}/></MenuPopup>}
  </div>;
}

/**
 * The preset zone tiles (`DropZonePresetsView`): a file dropped on one is optimised and then runs that zone's pipeline. The grid reads the
 * pointer itself and asks `tileAt` which tile is under it, so the gaps between tiles never lose a drag.
 */
function PresetGrid({ presets, run, onPin }: { presets: PresetTiles; run: Run; onPin: (pinned: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null), [hover, setHover] = useState<number>();
  const cells = cellCount(presets), under = (event: DragEvent) => { const rect = box.current!.getBoundingClientRect(); return tileAt(event.clientX - rect.left, event.clientY - rect.top, cells); };
  const names = [...presets.tiles.map(tile => tile.name), 'Add preset'];
  return <div ref={box} className="preset-grid" role="group" aria-label="Preset zones" style={{ width: TILE.columns * (TILE.width + TILE.gap) - TILE.gap, height: gridHeight(cells) }}
    onDragEnter={() => onPin(true)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) { setHover(undefined); onPin(false); } }}
    onDragOver={event => { const index = under(event); setHover(index); if (index !== undefined) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; } }}
    onDrop={event => {
      const index = under(event), tile = index === undefined ? undefined : presets.tiles[index];
      event.preventDefault(); event.stopPropagation(); setHover(undefined); onPin(false);
      // A drop on the "Add preset" tile or an empty cell runs nothing; it opens the preset zones, as the tile does on a click.
      if (!tile) { if (index !== undefined) void run(() => api.window('presets')); return; }
      const files = Array.from(event.dataTransfer.files);
      if (files.length) void run(() => api.runPreset(tile.id, files), `Running ${tile.name}`); else void run(async () => { throw new Error('Drop files on a preset zone.'); });
    }}>
    {names.slice(0, cells).map((name, index) => {
      const add = index === presets.tiles.length, { x, y } = tileOrigin(index), tile = presets.tiles[index];
      return <button key={tile?.id ?? 'add'} type="button" className={`preset-tile${add ? ' add' : ''}${hover === index ? ' over' : ''}`} style={{ left: x, top: y, width: TILE.width, height: TILE.height }}
        title={add ? 'Add a preset zone' : `Drop on this tile to run ${name}`} onClick={() => void run(() => api.window('presets'))}>
        <span className="preset-icon" aria-hidden="true">{add ? '+' : glyph(tile.icon)}</span><span className="preset-name">{name}</span>
      </button>;
    })}
  </div>;
}
