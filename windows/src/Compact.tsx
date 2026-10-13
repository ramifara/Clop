import type { MouseEvent } from 'react';
import type { ButtonDef } from '../core/cards/actions';
import { api } from './api';
import type { OpenMenu } from './Cards';
import { Icon } from './icons';
import { cardButtons, duration, humanSize, NOUNS, toastFor, type Run } from './results';
import type { AppState, ItemResult } from './types';

/**
 * The compact results list (CompactResult.swift): a row per result with the side buttons `compactResultActions` picks, taking over from the
 * cards when more results show than fit (or with `alwaysShowCompactResults`). Ctrl-click or Shift-click selects results, and the
 * right-click menu then works on all of them.
 */
export function CompactList({ state, run, selection, onSelection, onMenu, onSelect }: {
  state: AppState; run: Run; selection: string[]; onSelection: (ids: string[]) => void; onMenu: OpenMenu; onSelect: (id: string) => void;
}) {
  const { items, settings, native } = state;
  const done = items.filter(item => item.status === 'ready').length, failed = items.filter(item => item.status === 'error').length, running = items.length - done - failed;
  const selected = new Set(selection);
  function click(item: ItemResult, event: MouseEvent) {
    if (event.ctrlKey || event.metaKey) onSelection(selected.has(item.id) ? selection.filter(id => id !== item.id) : [...selection, item.id]);
    else if (event.shiftKey && selection.length) {
      const from = items.findIndex(other => other.id === selection.at(-1)), to = items.findIndex(other => other.id === item.id);
      onSelection([...new Set([...selection, ...items.slice(Math.min(from, to), Math.max(from, to) + 1).map(other => other.id)])]);
    } else if (selection.length) onSelection([]);
  }
  const act = (ids: string[], button: ButtonDef, event: MouseEvent) => {
    event.stopPropagation();
    if (button.menu) { onMenu(ids, button.menu, { x: event.clientX, y: event.clientY }); return; }
    const invoke = button.invoke;
    if (invoke) void run(() => api.cardAction(ids, invoke), toastFor(invoke.action));
  };
  return <section className="compact-list" aria-label="Results" onContextMenu={event => event.preventDefault()}>
    <header className="compact-header">
      <span role="status">{selection.length ? `${selection.length} selected` : `${items.length} result${items.length === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}${failed ? ` · ${failed} failed` : ''}`}</span>
      {selection.length > 0 ? <span className="compact-tools">
        <button onClick={event => onMenu(selection, undefined, { x: event.clientX, y: event.clientY })}>Actions…</button><button onClick={() => onSelection([])}>Done</button>
      </span> : settings.showCopyClearButtons && <span className="compact-tools">
        <button onClick={() => void run(() => api.cardAction(items.filter(item => item.status === 'ready').map(item => item.id), { action: 'copy' }), 'Copied')} disabled={!done}>Copy all</button>
        <button onClick={() => void run(async () => { for (const item of items) await api.dismiss(item.id); })}>Clear all</button>
      </span>}
    </header>
    <ul className="compact-rows">
      {items.map(item => {
        const busy = item.status === 'processing', ready = item.status === 'ready', saved = Math.min(99.9, Math.round((1 - item.outputBytes / item.originalBytes) * 1000) / 10);
        const buttons = ready ? cardButtons(state, item, true) : [];
        const facts = [item.kind === 'image' || (item.kind === 'video' && item.width) ? `${item.width}×${item.height}` : '', item.durationMs ? duration(item.durationMs) : '', item.pages ? `${item.pages} p` : ''].filter(Boolean).join(' · ');
        return <li key={item.id} className={`compact-row ${selected.has(item.id) ? 'selected' : ''} ${settings.showCompactImages ? 'with-image' : ''} ${item.status}`} aria-selected={selected.has(item.id)} aria-label={`${NOUNS[item.kind]} ${item.name}`}
          onClick={event => click(item, event)} onPointerEnter={() => onSelect(item.id)} onContextMenu={event => { event.preventDefault(); onMenu(selected.has(item.id) && selection.length > 1 ? selection : [item.id], undefined, { x: event.clientX, y: event.clientY }); }}>
          <div className="compact-main" draggable={native && ready} onDragStart={event => { event.preventDefault(); if (native && ready) api.drag(item.id); }}>
            {settings.showCompactImages && <img className="compact-thumb" src={item.preview} alt="" draggable={false}/>}
            <div className="compact-info">
              <span className="compact-name" title={item.name}>{item.name}</span>
              {busy ? <span className="compact-progress">{item.progress ? <span className="progress-bar" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}><span style={{ width: `${Math.round(item.progress * 100)}%` }}/></span> : <span className="spinner"/>}Optimising…</span>
                : item.error ? <span className="compact-error" title={item.error}>{item.error}</span>
                : <span className="compact-sizes"><span className={item.outputBytes < item.originalBytes ? 'old' : ''}>{humanSize(item.originalBytes)}</span>{item.outputBytes !== item.originalBytes && <> → <strong className={saved < 0 ? 'larger' : ''}>{humanSize(item.outputBytes)}</strong></>}{saved > 0 && !item.restored ? ` · −${saved}%` : item.restored ? ' · Original' : ''}{facts ? <span className="compact-facts"> · {facts}</span> : null}</span>}
            </div>
          </div>
          <div className="compact-actions">
            {buttons.map(button => <button key={button.name} aria-label={button.label} title={settings.hideFloatingResultTooltips ? undefined : button.label} onClick={event => act([item.id], button, event)}><Icon name={button.icon} size={13}/></button>)}
          </div>
          <button className="compact-close" aria-label={`Dismiss ${NOUNS[item.kind]}`} title={settings.hideFloatingResultTooltips ? undefined : busy ? 'Stop' : 'Dismiss'} onClick={event => { event.stopPropagation(); void run(() => busy && native ? api.cardAction([item.id], { action: 'stop' }) : api.dismiss(item.id)); }}><Icon name="close" size={11}/></button>
        </li>;
      })}
    </ul>
  </section>;
}
