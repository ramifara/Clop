import { useEffect, useState, type MouseEvent } from 'react';
import type { ButtonDef } from '../core/cards/actions';
import { api } from './api';
import { keptSize } from './crop-geometry';
import { Icon } from './icons';
import { cardButtons, duration, humanSize, NOUNS, toastFor, type Run } from './results';
import type { AppState, ImageOptions, ItemResult } from './types';

export type OpenMenu = (ids: string[], name: string | undefined, at: { x: number; y: number }) => void;
const FORMATS = ['png', 'jpeg', 'webp', 'avif', 'gif'] as const;
const formatName = (format: string) => format === 'jpeg' ? 'JPG' : format.toUpperCase();

/** A full-size result card: its thumbnail, the corner buttons `floatingResultActions` picks, and the format bar or extension chip. */
export function ResultCard({ item, state, run, onSelect, onMenu }: { item: ItemResult; state: AppState; run: Run; onSelect: () => void; onMenu: OpenMenu }) {
  const { native, settings } = state;
  const [panel, setPanel] = useState<'scale' | 'compression' | 'dimensions' | null>(null);
  const [scale, setScale] = useState(Math.round(item.width / keptSize(item.options.crop, item.originalWidth, item.originalHeight).width * 100));
  const [edge, setEdge] = useState(Math.max(item.width, item.height).toString());
  const [hovering, setHovering] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [picker, setPicker] = useState(false);
  const ready = item.status === 'ready', busy = item.status === 'processing', image = item.kind === 'image';
  const saved = Math.min(99.9, Math.round((1 - item.outputBytes / item.originalBytes) * 1000) / 10);
  const expanded = hovering && !collapsed, kept = keptSize(item.options.crop, item.originalWidth, item.originalHeight);
  const tip = (text: string) => settings.hideFloatingResultTooltips ? undefined : text;
  const hoverPicker = settings.formatPickerStyle === 'extensionHover';
  useEffect(() => { setScale(Math.round(item.width / keptSize(item.options.crop, item.originalWidth, item.originalHeight).width * 100)); setEdge(Math.max(item.width, item.height).toString()); }, [item.width, item.height, item.originalWidth, item.originalHeight, item.options.crop]);
  const apply = (options: Partial<ImageOptions>) => { setPanel(null); setCollapsed(true); setPicker(false); void run(() => api.apply(item.id, { ...item.options, ...options })); };
  function commitScale(value = scale) { apply({ scale: value / 100, maxEdge: undefined }); }
  function press(button: ButtonDef, event: MouseEvent) {
    if (button.panel) { setPanel(button.panel); return; }
    if (button.menu) { onMenu([item.id], button.menu, { x: event.clientX, y: event.clientY }); return; }
    const invoke = button.invoke;
    if (invoke) { setCollapsed(true); void run(() => api.cardAction([item.id], invoke), toastFor(invoke.action)); }
  }
  const buttons = !busy && !item.error ? cardButtons(state, item, false) : [];
  const change = saved > 0 && !item.restored ? ` · −${saved}%` : item.restored ? ' · Original' : '';
  const details = [item.kind === 'video' && item.width ? `${item.width}×${item.height}` : '', item.durationMs ? duration(item.durationMs) : '', item.pages ? `${item.pages} page${item.pages === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  const formatBar = <div className="format-bar" role="group" aria-label="Image format">{FORMATS.map(format => <button key={format} disabled={busy || (item.animated && !['gif', 'webp'].includes(format))} aria-label={`Convert to ${formatName(format)}`} aria-pressed={item.format === format} className={item.format === format ? 'active' : ''} onClick={() => apply({ format })}>{formatName(format)}</button>)}</div>;
  return <article className={`corner-card ${expanded || panel ? 'expanded' : ''} ${busy ? 'processing' : ''}`} aria-label={`Optimised ${item.name}`} onContextMenu={event => { event.preventDefault(); onMenu([item.id], undefined, { x: event.clientX, y: event.clientY }); }}
    onPointerEnter={() => { setHovering(true); setCollapsed(false); onSelect(); }} onPointerLeave={() => { setHovering(false); setPanel(null); setPicker(false); }} onFocus={onSelect}>
    <div className="thumbnail" draggable={native && ready && !panel} onDragStart={event => { event.preventDefault(); if (native && ready && !panel) api.drag(item.id); }} onDoubleClick={() => { if (ready && native) void run(() => api.reveal(item.id)); }}>
      <img src={item.preview} alt={item.name} draggable={false}/><div className="thumbnail-shade"/><div className="hover-glass"/>
    </div>
    <div className="window-grip" title={tip('Move result')}/>
    <div className="card-corners"><button className="corner-button close" aria-label={`Dismiss ${NOUNS[item.kind]}`} title={tip('Dismiss')} onClick={() => void run(() => api.dismiss(item.id))}><Icon name="close" size={10}/></button><button className="corner-button more" aria-label="More actions" title={tip('More actions')} disabled={busy} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); onMenu([item.id], undefined, { x: box.left, y: box.bottom }); }}>•••</button></div>
    {panel === 'scale' ? <div className="card-panel scale-panel"><button className="panel-close" aria-label="Close downscale" onClick={() => setPanel(null)}><Icon name="close" size={10}/></button><strong>{scale}% · {Math.round(kept.width * scale / 100)}×{Math.round(kept.height * scale / 100)}</strong><input autoFocus type="range" aria-label="Downscale" min="10" max="100" step="5" value={scale} onChange={event => setScale(Number(event.target.value))} onPointerUp={event => commitScale(Number(event.currentTarget.value))} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) commitScale(Number(event.currentTarget.value)); }}/><div className="scale-presets">{[100, 75, 50, 25, 10].map(value => <button key={value} disabled={busy} onClick={() => commitScale(value)}>{value}%</button>)}</div></div>
    : panel === 'compression' ? <div className="card-panel compression-panel"><strong>Compression</strong>{(['balanced', 'aggressive', 'lossless'] as const).map(mode => <button key={mode} className={mode === item.options.mode && !item.options.compression ? 'active' : ''} onClick={() => apply({ mode, compression: undefined })}>{mode === 'balanced' ? 'Balanced' : mode === 'aggressive' ? 'Smaller' : 'Lossless'}</button>)}</div>
    : panel === 'dimensions' ? <form className="card-panel dimension-panel" onSubmit={event => { event.preventDefault(); apply({ maxEdge: Number(edge), scale: 1 }); }}><label htmlFor={`edge-${item.id}`}>Longest edge</label><div><input id={`edge-${item.id}`} autoFocus type="number" min="1" max="16000" value={edge} onChange={event => setEdge(event.target.value)}/><span>px</span><button type="submit" aria-label="Apply dimensions"><Icon name="check" size={14}/></button></div></form>
    : buttons.length > 0 && <div className="action-grid" aria-label={`${NOUNS[item.kind]} actions`}>{buttons.map(button => <button key={button.name} className="grid-button" aria-label={button.label} title={tip(button.label)} onPointerDown={event => { if (button.panel === 'scale') { event.preventDefault(); setPanel('scale'); } }} onClick={event => { if (!button.panel) press(button, event); }}><Icon name={button.icon} size={17}/></button>)}</div>}
    <div className="card-bottom">
      {!busy && !item.error && !panel && item.notes?.length ? <div className="card-notes" role="status" title={item.notes.join('\n')}>{item.notes[0]}{item.notes.length > 1 ? ` (+${item.notes.length - 1})` : ''}</div> : null}
      {busy ? <div className="card-progress">{item.progress ? <div className="progress-bar" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}><span style={{ width: `${Math.round(item.progress * 100)}%` }}/></div> : <span className="spinner"/>}<span>Optimising…{item.progress ? ` ${Math.round(item.progress * 100)}%` : ''}</span></div>
        : item.error ? <div className="card-error" role="alert">{item.error}<button onClick={() => void run(() => api.restore(item.id))}>Restore original</button></div> : panel ? null : <>
        <div className="size-diff"><span className={item.outputBytes < item.originalBytes ? 'old' : ''}>{humanSize(item.originalBytes)}</span>{item.outputBytes !== item.originalBytes && <><Icon name="arrow" size={11}/><strong className={saved < 0 ? 'larger' : ''}>{humanSize(item.outputBytes)}</strong></>}</div>
        {image ? <button className="resolution-chip" aria-label="Set dimensions" title={tip('Set dimensions')} disabled={busy} onClick={() => setPanel('dimensions')}>{item.width}×{item.height}{change}</button>
          : <span className="resolution-chip">{details}{details ? change : change.slice(3)}</span>}
        <span className="filename-chip" title={item.name}>{item.name.replace(/\.[^.]+$/, '')}</span>
      </>}
    </div>
    {image ? (hoverPicker ? <div className="format-picker" onPointerEnter={() => setPicker(true)}>{picker && formatBar}<button className="ext-chip" aria-label="Change format" aria-expanded={picker} onClick={() => setPicker(value => !value)}>{formatName(item.format)}</button></div> : formatBar)
      : <div className="format-bar kind-bar" aria-label="File type">{item.format.toUpperCase()}</div>}
  </article>;
}
