import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ACTION_KINDS, itemMenu, submenu, batchMenu, SHORTCUTS, type Invocation, type MenuNode } from '../core/cards/actions';
import { api, errorText } from './api';
import { ResultCard, type OpenMenu } from './Cards';
import { keptSize } from './crop-geometry';
import { CompactList } from './Compact';
import { factsFor, toastFor, type Run } from './results';
import { Icon } from './icons';
import { SettingsWindow } from './SettingsWindow';
import { Welcome } from './Welcome';
import { slotsFor, tileAt } from '../core/pipeline/zones';
import { glyph } from './editor/glyphs';
import { acceptAsCopy, aggressiveDrop, zonesKey } from './drag-keys';
import { MenuPopup, MenuView } from './Menu';
import type { AppState, ClopSettings, PresetTiles } from './types';

const preferences = new URLSearchParams(location.search).has('preferences');

export function App() {
  const [state, setState] = useState<AppState>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [localDrag, setLocalDrag] = useState(false);
  const [selected, setSelected] = useState<string>();
  // Ctrl (the preset zones) and Shift (aggressive) held over a drag inside this window, for the browser preview: the app learns them from the Windows helper instead.
  const [heldKeys, setHeldKeys] = useState(false), [shiftHeld, setShiftHeld] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [popup, setPopup] = useState<{ nodes: MenuNode[]; ids: string[]; x: number; y: number }>();
  const notification = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interactive = useRef(false);
  const dropTarget = useRef<HTMLDivElement>(null), sentBox = useRef('');
  const glass = state?.glass === 'acrylic' && !preferences;
  // With acrylic, a window of its own draws the drop zone's glass; it follows the zone's box, measured after every layout.
  useLayoutEffect(() => {
    if (!glass) return;
    const report = () => {
      const box = dropTarget.current?.getBoundingClientRect();
      const next = box ? { x: box.x, y: box.y, width: box.width, height: box.height, pageWidth: innerWidth, pageHeight: innerHeight } : null, key = JSON.stringify(next);
      if (key !== sentBox.current) { sentBox.current = key; api.dropZone(next).catch(() => { sentBox.current = ''; }); }
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(document.documentElement); if (dropTarget.current) observer.observe(dropTarget.current);
    return () => observer.disconnect();
  });
  useEffect(() => {
    api.state().then(setState).catch(error => setError(error.message));
    return api.subscribe(setState);
  }, []);
  useEffect(() => { document.documentElement.classList.toggle('browser-preview', state?.native === false); }, [state?.native]);
  useEffect(() => { if (state?.native && !state.dropActive && !state.settings.keepDropZoneVisible) setLocalDrag(false); }, [state?.native, state?.dropActive, state?.settings.keepDropZoneVisible]);
  const targetShown = Boolean(state && (state.dropActive || state.settings.keepDropZoneVisible || localDrag));
  useEffect(() => { if (!targetShown) { setHeldKeys(false); setShiftHeld(false); } }, [targetShown]);
  useEffect(() => () => { if (notification.current) clearTimeout(notification.current); }, []);
  // A selection in the compact list holds back clearing it, and goes with the results it named.
  useEffect(() => { if (state && selection.some(id => !state.items.some(item => item.id === id))) setSelection(selection.filter(id => state.items.some(item => item.id === id))); }, [state, selection]);
  useEffect(() => { if (state?.native) void api.window(selection.length ? 'select' : 'unselect'); }, [state?.native, selection.length]);
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
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('.corner-card,.drop-target,.corner-notice,.welcome-card,.stack-actions,.compact-list,.menu-popup');
      if (Boolean(hit) !== interactive.current) { interactive.current = Boolean(hit); void api.window(hit ? 'interactive' : 'passthrough'); }
    };
    document.addEventListener('mousemove', move); return () => document.removeEventListener('mousemove', move);
  }, [state?.native]);
  if (!state) return null;
  if (preferences) return <SettingsWindow state={state} refresh={async () => setState(await api.state())}/>;
  function drop(event: DragEvent) {
    acceptAsCopy(event); setLocalDrag(false);
    if (zonesShown) return;
    const files = Array.from(event.dataTransfer.files), aggressive = aggressiveDrop(event);
    if (files.length) void run(() => api.importFiles(files, aggressive));
    else {
      const url = (event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')).split('\n').find(line => /^https?:\/\//i.test(line.trim()));
      if (url) void run(() => api.importUrl(url.trim(), aggressive));
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
  // The preset zones take the drop zone's place inside it while their key is down or pinned (`draggingOutsideView`); then only they take a drop.
  const zonesShown = Boolean(targetShown && state.presets && (state.native ? state.presets.revealed : heldKeys));
  return <div className={`corner-surface ${state.settings.floatingResultsCorner} ${compact ? 'compact' : ''} ${glass ? 'acrylic' : ''}`} onDragOver={event => { setHeldKeys(zonesKey(event)); setShiftHeld(aggressiveDrop(event)); if (!zonesShown && imageDrag(event)) acceptAsCopy(event); }} onDragEnter={event => { if (imageDrag(event)) { acceptAsCopy(event); setLocalDrag(true); } }} onDrop={drop}>
    <div className="corner-stack">
      {targetShown && <div ref={dropTarget} className={`drop-target${localDrag ? ' receiving' : ''}${zonesShown ? ' zones' : ''}`} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setLocalDrag(false); }}>
        {zonesShown ? <PresetGrid presets={state.presets!} run={run}/> : <><strong>Drop to optimise</strong><div className="drop-ring" aria-hidden="true"/><div className="drop-hints">{dropHints(state.settings, Boolean(state.native ? state.aggressiveHeld : shiftHeld))}</div></>}
      </div>}
      {compact ? <CompactList state={state} run={run} selection={selection} onSelection={setSelection} onMenu={openMenu} onSelect={setSelected}/>
        : cards.map(item => <ResultCard key={item.id} item={item} state={state} run={run} onSelect={() => setSelected(item.id)} onMenu={openMenu}/>)}
      {state.welcome && <Welcome settings={state.settings} onDismiss={() => void api.window('finish-welcome')}/>}
      {(error || state.notice) && <div className="corner-notice" role="alert"><span>{error || state.notice}</span><button aria-label="Dismiss message" onClick={() => { setError(''); void api.window('dismiss-notice'); }}><Icon name="close" size={12}/></button></div>}
      {!compact && state.items.length > 1 && state.settings.showCopyClearButtons && <div className="stack-actions"><button onClick={() => void run(() => api.copy(state.items[0].id), 'Copied')}>Copy latest</button><button onClick={() => void run(async () => { for (const item of state.items) await api.dismiss(item.id); })}>Clear all</button></div>}
      {message && <div className="copy-toast" role="status">{message}</div>}
    </div>
    {popup && <MenuPopup at={{ x: popup.x, y: popup.y }}><MenuView nodes={popup.nodes} onInvoke={invoke}/></MenuPopup>}
  </div>;
}

/**
 * The key hints under the ring (`draggingOutsideView`), with the Windows keys for the Mac's: Ctrl shows the preset zones (Control), Alt
 * shows the drop zone when `onlyShowDropZoneOnOption` asks for it (Option), and Shift at the drop optimises aggressively (Command). The
 * aggressive line turns red while Shift is down, as the Mac's does for Command.
 */
function dropHints(settings: ClopSettings, aggressive: boolean): ReactNode[] {
  return [
    <small key="zones">{settings.onlyShowPresetZonesOnControlTapped ? 'Tap ' : ''}<kbd>Ctrl</kbd>: show preset zones</small>,
    settings.onlyShowDropZoneOnOption && !settings.keepDropZoneVisible && <small key="alt">Let go of <kbd>Alt</kbd>: hide drop zone</small>,
    <small key="aggressive" className={aggressive ? 'held' : undefined}><kbd>Shift</kbd>: use aggressive optimisation</small>,
  ].filter(Boolean);
}

/**
 * The preset zones, a two-by-two grid filling the drop zone (`DropZonePresetsView`): files and folders dropped on a zone run that zone's
 * pipeline (Shift held makes it aggressive), a drop on "Add preset" opens the preset zones, and an empty slot takes nothing. The grid reads the pointer itself
 * and asks `tileAt` which slot is under it, so the gaps between slots never lose a drag.
 */
function PresetGrid({ presets, run }: { presets: PresetTiles; run: Run }) {
  const box = useRef<HTMLDivElement>(null), [hover, setHover] = useState<number>();
  const slots = slotsFor(presets);
  const under = (event: DragEvent) => {
    const rect = box.current!.getBoundingClientRect(), index = tileAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    return index === undefined || slots[index].kind === 'empty' ? undefined : index;
  };
  return <div ref={box} className="preset-grid" role="group" aria-label="Preset zones"
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setHover(undefined); }}
    onDragOver={event => { const index = under(event); setHover(index); if (index !== undefined) acceptAsCopy(event); }}
    onDrop={event => {
      const index = under(event), slot = index === undefined ? undefined : slots[index];
      acceptAsCopy(event); event.stopPropagation(); setHover(undefined);
      if (slot?.kind === 'add') { void run(() => api.window('presets')); return; }
      if (slot?.kind !== 'zone') return;
      const files = Array.from(event.dataTransfer.files), { tile } = slot;
      if (files.length) void run(() => api.runPreset(tile.id, files, aggressiveDrop(event)), `Running ${tile.name}`); else void run(async () => { throw new Error('Drop files on a preset zone.'); });
    }}>
    {slots.map((slot, index) => {
      if (slot.kind === 'empty') return <div key={`empty-${index}`} className="preset-slot empty" aria-hidden="true"><span className="preset-icon"><SlotMark/></span><span className="preset-name">No preset</span></div>;
      const add = slot.kind === 'add', name = add ? 'Add preset' : slot.tile.name;
      return <button key={add ? 'add' : slot.tile.id} type="button" className={`preset-slot${add ? ' add' : ''}${hover === index ? ' over' : ''}`}
        title={add ? 'Add a preset zone' : `Drop here to run ${name}`} onClick={() => void run(() => api.window('presets'))}>
        <span className="preset-icon" aria-hidden="true">{add ? <SlotMark add/> : glyph(slot.tile.icon)}</span><span className="preset-name">{name}</span>
      </button>;
    })}
  </div>;
}

/** The dashed square of an empty slot, with a plus on the one that adds a zone (`square.dashed`, `plus.square.dashed`). */
function SlotMark({ add = false }: { add?: boolean }) {
  return <svg className="slot-mark" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <rect x="1.75" y="1.75" width="16.5" height="16.5" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3.4 2.4" strokeDashoffset="1.4"/>
    {add && <path d="M10 6.2v7.6M6.2 10h7.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>}
  </svg>;
}
