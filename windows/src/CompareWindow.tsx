import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorText } from './api';
import type { CompareSide, CompareSources } from './types';
import './views.css';

type Mode = 'split' | 'sideBySide';
type Pane = 'original' | 'result' | 'split';
const MODE_KEY = 'clop.compareMode';
const humanSize = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1000))} KB`;
const clock = (seconds: number) => { const s = Math.max(0, Math.floor(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const dimensions = (side: CompareSide) => side.width && side.height ? `${side.width}×${side.height}` : '';
const clamp = (value: number) => Math.min(Math.max(value, 0), 1);

/**
 * The compare window (CompareView.swift): the original and the current result side by side or split by a draggable divider, with
 * the same zoom on both (hold Ctrl, add Alt to zoom further; the cursor pans). Videos play together, PDFs compare a page at a time,
 * and audio files get a player each.
 */
export function CompareWindow({ id }: { id: string }) {
  const [sources, setSources] = useState<CompareSources>();
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState<Mode>(() => localStorage.getItem(MODE_KEY) === 'sideBySide' ? 'sideBySide' : 'split');
  const [fill, setFill] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [origin, setOrigin] = useState({ x: .5, y: .5 });
  const [split, setSplit] = useState(.5);
  const panes = useRef(new Map<Pane, HTMLElement>()), activePane = useRef<Pane>(undefined), pointer = useRef<{ x: number; y: number }>(undefined);
  const videos = useRef(new Map<'original' | 'result', HTMLVideoElement>());

  useEffect(() => {
    let current = true;
    api.compareSources(id, { page }).then(next => { if (current) { setSources(next); setError(''); } }, error => { if (current) setError(errorText(error)); });
    return () => { current = false; };
  }, [id, page]);
  useEffect(() => { localStorage.setItem(MODE_KEY, mode); activePane.current = undefined; }, [mode]);
  useEffect(() => { for (const video of videos.current.values()) void (playing ? video.play().catch(() => {}) : video.pause()); }, [playing, sources, mode]);
  // The result follows the original's time, so both show the same moment.
  useEffect(() => {
    const original = videos.current.get('original'), result = videos.current.get('result');
    if (!original || !result) return;
    const sync = () => { if (Math.abs(result.currentTime - original.currentTime) > 0.2) result.currentTime = original.currentTime; };
    original.addEventListener('timeupdate', sync); return () => original.removeEventListener('timeupdate', sync);
  }, [sources, mode]);

  const kind = sources?.item.kind;
  /** Anchors the zoom inside the pane it started in: the cursor is clamped to that pane, and both panes mirror the same point. */
  function follow() {
    const at = pointer.current; if (!at) return;
    const pane = activePane.current ?? [...panes.current].find(([, element]) => { const r = element.getBoundingClientRect(); return at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom; })?.[0];
    const element = pane && panes.current.get(pane); if (!pane || !element) return;
    activePane.current = pane;
    const r = element.getBoundingClientRect();
    if (r.width && r.height) setOrigin({ x: clamp((at.x - r.left) / r.width), y: clamp((at.y - r.top) / r.height) });
  }
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.type === 'keydown' && event.key === 'Escape') { void api.window('close'); return; }
      if (kind !== 'audio') {
        const next = event.ctrlKey ? (event.altKey ? 8 : 3) : 1;
        if (next !== zoom) { if (next > 1) follow(); else { activePane.current = undefined; setOrigin({ x: .5, y: .5 }); } setZoom(next); }
        if (event.key === 'Alt') event.preventDefault();
      }
      if (event.type !== 'keydown' || event.repeat || (event.target instanceof HTMLInputElement && event.target.type !== 'range')) return;
      if (event.key === ' ' && kind === 'video') { event.preventDefault(); setPlaying(value => !value); }
      else if (event.key === ' ' && kind === 'image') { event.preventDefault(); setFill(value => !value); }
      else if (kind === 'pdf' && sources?.pages && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) setPage(value => Math.min(Math.max(value + (event.key === 'ArrowLeft' ? -1 : 1), 1), sources.pages!));
    };
    const blur = () => { setZoom(1); activePane.current = undefined; };
    document.addEventListener('keydown', keys); document.addEventListener('keyup', keys); window.addEventListener('blur', blur);
    return () => { document.removeEventListener('keydown', keys); document.removeEventListener('keyup', keys); window.removeEventListener('blur', blur); };
  });

  if (!sources) return <div className="view-window compare-window"><div className="view-loading">{error || <span className="spinner"/>}</div></div>;
  const { original, result } = sources;
  const percent = original.bytes > 0 && result.bytes !== original.bytes ? Math.trunc((original.bytes - result.bytes) * 100 / original.bytes) : 0;
  const badge = percent !== 0 && <span className={`savings ${percent > 0 ? 'smaller' : 'larger'}`}>{percent > 0 ? `-${percent}%` : `+${-percent}%`}</span>;
  const register = (pane: Pane) => (element: HTMLElement | null) => { if (element) panes.current.set(pane, element); else panes.current.delete(pane); };
  const zoomStyle = { transform: `scale(${zoom})`, transformOrigin: `${origin.x * 100}% ${origin.y * 100}%` };
  function media(side: CompareSide, which: 'original' | 'result') {
    if (side.kind === 'video') return <VideoSide side={side} register={element => { if (element) videos.current.set(which, element); else videos.current.delete(which); }}/>;
    return <img src={side.url} alt={which === 'original' ? 'Original' : 'Optimised'} draggable={false} style={{ objectFit: side.kind === 'image' && fill ? 'cover' : 'contain' }}/>;
  }
  const header = (title: string, side: CompareSide) => <header><strong>{title}</strong><small>{side.format.toUpperCase()}</small></header>;
  const labels = (side: CompareSide) => <div className="side-labels"><span>Size: {humanSize(side.bytes)}</span>{dimensions(side) && <span>Dimensions: {dimensions(side)}</span>}</div>;

  let body: ReactNode;
  if (kind === 'audio') body = <AudioCompare sources={sources} badge={badge}/>;
  else if (mode === 'split') body = <div className="split-stack">
    <div className="split-headers">{header('Original', original)}{header('Optimised', result)}</div>
    <div className="split-view" ref={register('split')} onPointerMove={event => { pointer.current = { x: event.clientX, y: event.clientY }; if (zoom > 1) follow(); if (event.buttons === 1) { const r = event.currentTarget.getBoundingClientRect(); setSplit(clamp((event.clientX - r.left) / r.width)); } }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); const r = event.currentTarget.getBoundingClientRect(); setSplit(clamp((event.clientX - r.left) / r.width)); }}>
      <div className="layer" style={zoomStyle}>{media(result, 'result')}</div>
      <div className="layer" style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}><div className="layer" style={zoomStyle}>{media(original, 'original')}</div></div>
      <div className="divider" style={{ left: `${split * 100}%` }}><span>↔</span></div>
    </div>
    <div className="split-footer"><span>{humanSize(original.bytes)}</span>{result.bytes !== original.bytes && <><span>→</span><span className={result.bytes < original.bytes ? 'smaller' : 'larger'}>{humanSize(result.bytes)}</span></>}{badge}
      {dimensions(original) && <><span className="dot">•</span><span>{dimensions(original)}</span>{dimensions(result) !== dimensions(original) && <><span>→</span><span>{dimensions(result)}</span></>}</>}</div>
  </div>;
  else body = <div className="side-stack" onPointerMove={event => { pointer.current = { x: event.clientX, y: event.clientY }; if (zoom > 1) follow(); }}>
    {([['Original', original, 'original'], ['Optimised', result, 'result']] as const).map(([title, side, which]) => <section key={which} className="side">
      {header(title, side)}
      <div className="side-media" ref={register(which)}><div className="layer" style={zoomStyle}>{media(side, which)}</div></div>
      {labels(side)}
    </section>)}
    <div className="side-badge">{badge}</div>
  </div>;

  return <div className="view-window compare-window">
    {body}
    {error && <p className="view-error" role="alert">{error}</p>}
    {kind !== 'audio' && <div className="compare-controls">
      <div className="segmented" role="group" aria-label="Comparison">
        <button aria-pressed={mode === 'sideBySide'} className={mode === 'sideBySide' ? 'active' : ''} title="Side by side comparison" onClick={() => setMode('sideBySide')}><svg width="18" height="12" viewBox="0 0 18 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="1" y="1" width="16" height="10" rx="2"/><path d="M9 1v10"/></svg></button>
        <button aria-pressed={mode === 'split'} className={mode === 'split' ? 'active' : ''} title="Split comparison with a draggable divider" onClick={() => setMode('split')}><svg width="18" height="12" viewBox="0 0 18 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="1" y="1" width="16" height="10" rx="2"/><path d="M3 3h6v6H3z" fill="currentColor"/></svg></button>
      </div>
      {kind === 'video' && <button className="flat" aria-label={playing ? 'Pause both videos' : 'Play both videos'} title={playing ? 'Pause both videos' : 'Play both videos'} onClick={() => setPlaying(!playing)}>{playing ? '❚❚' : '▶'}</button>}
      {kind === 'image' && <button className="flat" aria-label={fill ? 'Fit the whole image' : 'Fill the preview area'} title={fill ? 'Fit the whole image' : 'Fill the preview area'} onClick={() => setFill(!fill)}>{fill ? '⤡' : '⤢'}</button>}
    </div>}
    {kind === 'pdf' && sources.pages && <div className="pdf-controls">
      {sources.pages > 1 && <button className="flat" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>}
      <span>Page {sources.page}/{sources.pages}</span>
      {sources.pages > 1 && <button className="flat" aria-label="Next page" disabled={page >= sources.pages} onClick={() => setPage(page + 1)}>›</button>}
      {sources.pages > 1 && <input type="range" aria-label="Page" min="1" max={sources.pages} step="1" value={page} onChange={event => setPage(Number(event.target.value))}/>}
    </div>}
    <p className="hint">{kind === 'audio' ? 'Only one side plays at a time, scrub either side to set where both start' : <>{mode === 'split' && <>Drag across the preview to move the split divider<br/></>}Hold <b>Ctrl</b> to zoom in, add <b>Alt</b> to zoom further</>}</p>
  </div>;
}

/** A muted, looping video, or a note when Chromium cannot play its format. */
function VideoSide({ side, register }: { side: CompareSide; register: (element: HTMLVideoElement | null) => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="unplayable">This {side.format.toUpperCase()} video cannot play here.</div>;
  return <video ref={register} src={side.url} muted loop playsInline autoPlay onError={() => setFailed(true)}/>;
}

/** Two players over the cover art; only one plays at a time, and scrubbing either sets where both start. */
function AudioCompare({ sources, badge }: { sources: CompareSources; badge: ReactNode }) {
  const players = useRef(new Map<'original' | 'result', HTMLAudioElement>());
  const [playing, setPlaying] = useState<'original' | 'result'>();
  const [position, setPosition] = useState(0);
  const [durations, setDurations] = useState<Record<string, number>>({});
  function toggle(which: 'original' | 'result') {
    for (const [other, player] of players.current) if (other !== which) player.pause();
    const player = players.current.get(which); if (!player) return;
    if (playing === which) { player.pause(); setPlaying(undefined); return; }
    player.currentTime = Math.min(position, player.duration || position);
    void player.play().then(() => setPlaying(which), () => setPlaying(undefined));
  }
  function scrub(time: number) { setPosition(time); for (const player of players.current.values()) player.currentTime = Math.min(time, player.duration || time); }
  return <div className="audio-stack">
    {([['Original', sources.original, 'original'], ['Optimised', sources.result, 'result']] as const).map(([title, side, which]) => {
      const duration = durations[which] ?? (side.durationMs ?? 0) / 1000;
      return <section key={which} className="audio-side">
        <header><strong>{title}</strong><small>{side.format.toUpperCase()}</small></header>
        <div className="audio-art" style={{ backgroundImage: `url("${sources.item.originalPreview}")` }}>
          <button aria-label={playing === which ? 'Pause' : 'Play'} disabled={!duration} onClick={() => toggle(which)}>{playing === which ? '❚❚' : '▶'}</button>
        </div>
        <audio ref={element => { if (element) players.current.set(which, element); else players.current.delete(which); }} src={side.url} preload="metadata"
          onLoadedMetadata={event => { const value = event.currentTarget.duration; if (Number.isFinite(value)) setDurations(all => ({ ...all, [which]: value })); }}
          onTimeUpdate={event => { if (playing === which) setPosition(event.currentTarget.currentTime); }} onEnded={() => setPlaying(undefined)}/>
        <input type="range" aria-label={`${title} position`} min="0" max={Math.max(duration, 0.01)} step="0.01" value={Math.min(position, duration)} disabled={!duration} onChange={event => scrub(Number(event.target.value))}/>
        <div className="times"><span>{clock(Math.min(position, duration))}</span><span>{clock(duration)}</span></div>
        <div className="side-labels"><span>Size: {humanSize(side.bytes)}</span>{side.bitrate && <span>Bitrate: {side.bitrate} kbps</span>}</div>
      </section>;
    })}
    <div className="side-badge">{badge}</div>
  </div>;
}
