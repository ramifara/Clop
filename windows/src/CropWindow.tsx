import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { DEFAULT_CROP_ASPECT_RATIOS, DEFAULT_CROP_SIZES, type CropSizeGroup } from '../core/data/cropSizes';
import { DEVICE_SIZE_GROUPS } from '../core/data/deviceSizes';
import { PAPER_SIZE_GROUPS } from '../core/data/paperSizes';
import { computedSize } from '../core/media/crop-size';
import { api, errorText } from './api';
import { area, centeredMaxRect, evenSide, extendedCanvas, fractionalAspect, FULL, HANDLES, handlePoint, marquee, moved, orientationOf, oriented, reorientedAspect, resized, sameRect, selectionSize, sizedRect, targetSize, toBox, toRect, type Box, type Handle, type Size } from './crop-geometry';
import type { CropOrientation, CropRect, CropRequest, CropSize, CropSource } from './types';
import './views.css';

type Frame = 'plain' | 'paper' | 'device';
const PDF_RATIOS = DEFAULT_CROP_ASPECT_RATIOS.filter(size => size.name !== 'A4' && size.name !== 'B5');
const groupSize = (group: CropSizeGroup): CropSize => ({ width: group.width, height: group.height, name: group.name, longEdge: false, smartCrop: false, isAspectRatio: true });
const sizeId = (size: CropSize) => `${size.width || 'Auto'}×${size.height || 'Auto'}`;
const same = (a: CropSize, b: CropSize) => a.width === b.width && a.height === b.height && a.name === b.name;
const fit = (content: Size, box: Size) => { const scale = Math.min(box.width / content.width, box.height / content.height); return { width: content.width * scale, height: content.height * scale, scale }; };

/** The crop and resize window (CropWindow.swift): aspect ratios and saved sizes for images and videos, paper and device sizes for PDFs. */
export function CropWindow({ id }: { id: string }) {
  const [source, setSource] = useState<CropSource>();
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<CropSize[]>([]);
  const [rect, setRect] = useState<CropRect>(FULL);
  const [initialRect, setInitialRect] = useState<CropRect>(FULL);
  const [lockedAspect, setLockedAspect] = useState<number>();
  const [target, setTarget] = useState<Size>();
  const [presetName, setPresetName] = useState<string>();
  const [frame, setFrame] = useState<Frame>('plain');
  const [orientation, setOrientation] = useState<CropOrientation>('adaptive');
  const [rectEdited, setRectEdited] = useState(false);
  /** The PDF preset (paper, device or ratio) that crops or extends each page by its own size. */
  const [adaptiveAspect, setAdaptiveAspect] = useState<CropSize & { list: 'paper' | 'device' | 'ratio' }>();
  const [extend, setExtend] = useState(false);
  const [page, setPage] = useState(1);
  const [time, setTime] = useState(0);
  const [reloads, setReloads] = useState(0);
  const [saveName, setSaveName] = useState('');
  const [busy, setBusy] = useState(false);
  const setUp = useRef(false);
  const frameTime = Math.round(time * 50) / 50;

  useEffect(() => { api.cropSizes().then(setSaved, error => setError(errorText(error))); }, []);
  useEffect(() => {
    let current = true;
    api.cropSource(id, { page, time: frameTime }).then(next => { if (current) { setSource(next); setError(''); } }, error => { if (current) setError(errorText(error)); });
    return () => { current = false; };
  }, [id, page, frameTime, reloads]);
  useEffect(() => {
    if (!source) return;
    const pdf = source.item.kind === 'pdf';
    // A PDF starts from each page's current crop box, so re-cropping is visible and reversible.
    if (pdf) { const initial = source.initialRect ?? FULL; setInitialRect(initial); if (!rectEdited && lockedAspect === undefined) setRect(initial); }
    if (setUp.current) return;
    setUp.current = true;
    setOrientation(pdf ? 'adaptive' : orientationOf(source));
    // Re-cropping starts from the original with the last crop selected, and its preset when it had one.
    const last = source.item.options.crop;
    if (pdf || !last?.cropRect || source.item.restored) return;
    const full = sameRect(last.cropRect, FULL) || (last.cropRect.width >= 0.995 && last.cropRect.height >= 0.995);
    if (!full) { setInitialRect(last.cropRect); setRect(last.cropRect); }
    if (last.name) { setPresetName(last.name); setLockedAspect(last.width / last.height); setTarget({ width: last.width, height: last.height }); }
    else if (full) setTarget({ width: last.width, height: last.height });
  }, [source]);

  const close = () => void api.window('close');
  const kind = source?.item.kind, pdf = kind === 'pdf', unit = pdf ? 'pt' : 'px';
  const sourceSize: Size = source ? { width: source.width, height: source.height } : { width: 1, height: 1 };
  const extending = pdf && extend && !!adaptiveAspect;
  const space = extending ? extendedCanvas(sourceSize, fractionalAspect(adaptiveAspect!), orientation) : sourceSize;
  const output = targetSize(rect, space, target), selection = selectionSize(rect, space);
  const pixelWidth = Math.round(output.width), pixelHeight = Math.round(output.height);
  const nothingToCrop = !adaptiveAspect && sameRect(rect, initialRect) && output.width >= selection.width - 1 && output.height >= selection.height - 1;
  const shortName = !adaptiveAspect ? '' : DEVICE_SIZE_GROUPS.find(c => c.groups.some(g => g.name === adaptiveAspect.name))?.category ?? adaptiveAspect.name.split(' (')[0];
  const title = pdf && adaptiveAspect && (extend || !rectEdited) ? `${extend ? 'Extend' : 'Crop'} PDF to ${shortName}` : `Crop to ${pixelWidth}×${pixelHeight}`;

  function unlockAspect() { setLockedAspect(undefined); setTarget(undefined); setPresetName(undefined); setFrame('plain'); setAdaptiveAspect(undefined); }
  function reset() { setRect(initialRect); setRectEdited(false); unlockAspect(); }
  function applyAspectPreset(size: CropSize, style: Frame = 'plain', list?: 'paper' | 'device' | 'ratio') {
    const turned = oriented(size, pdf && orientation === 'adaptive' ? orientationOf(sourceSize) : orientation, sourceSize), aspect = turned.width / turned.height;
    const canvas = pdf && extend ? extendedCanvas(sourceSize, fractionalAspect(size), orientation) : sourceSize;
    setLockedAspect(aspect); setTarget(undefined); setPresetName(size.name); setFrame(style);
    setAdaptiveAspect(pdf && list ? { ...size, list } : undefined);
    setRect(centeredMaxRect(aspect, canvas)); setRectEdited(false);
    if (!size.isAspectRatio && orientation !== 'adaptive') setOrientation(orientationOf(turned));
  }
  function applySizePreset(size: CropSize) {
    // Auto sides and long-edge presets resolve against the source; the largest centred region of the size's aspect is kept, then scaled down to it.
    const resolved = computedSize(size, sourceSize.width, sourceSize.height);
    if (!(resolved.width > 0 && resolved.height > 0)) return;
    const aspect = resolved.width / resolved.height;
    setLockedAspect(aspect); setTarget(resolved); setPresetName(size.name); setFrame('plain'); setAdaptiveAspect(undefined);
    setRect(centeredMaxRect(aspect, sourceSize)); setRectEdited(false);
  }
  function changeOrientation(next: CropOrientation) {
    setOrientation(next);
    if (lockedAspect === undefined) return;
    const turned = reorientedAspect(lockedAspect, next, sourceSize, adaptiveAspect);
    if (turned === undefined || turned === lockedAspect) return;
    setLockedAspect(turned); setRect(centeredMaxRect(turned, extending ? extendedCanvas(sourceSize, fractionalAspect(adaptiveAspect!), next) : space));
  }
  function setPixelSize(value: string, changed: 'width' | 'height') {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    setRect(sizedRect(rect, space, { width: changed === 'width' ? n : pixelWidth, height: changed === 'height' ? n : pixelHeight }, changed, lockedAspect));
    setRectEdited(true); setTarget(undefined); setPresetName(undefined);
  }
  function toggleExtend(value: boolean) {
    setExtend(value);
    if (!adaptiveAspect) return;
    // The selection space switches between the page and the extended canvas.
    setRectEdited(false);
    setRect(value ? FULL : lockedAspect ? centeredMaxRect(lockedAspect, sourceSize) : initialRect);
  }
  async function run(request: CropRequest, keepOpen = false) {
    setBusy(true); setError('');
    try { await api.crop(id, request); if (keepOpen) { setRectEdited(false); unlockAspect(); setReloads(n => n + 1); } else close(); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  function applyCrop() {
    if (busy || nothingToCrop || !source) return;
    if (pdf) {
      const fit = adaptiveAspect && { aspectRatio: fractionalAspect(adaptiveAspect), orientation };
      if (fit && extend) return void run({ type: 'pdf-aspect', ...fit, extend: true, ...(rectEdited ? { rect } : {}) });
      // An aspect fits each page by its own size and orientation; one shared region would distort mixed documents.
      if (fit && !rectEdited) return void run({ type: 'pdf-aspect', ...fit, extend: false });
      return void run({ type: 'pdf-rect', rect });
    }
    // The region goes along even when it is the whole frame, so a plain downscale also starts from the original and reopens as it was.
    void run({ type: 'size', size: { width: evenSide(output.width), height: evenSide(output.height), name: presetName ?? '', longEdge: false, smartCrop: false, cropRect: rect } });
  }
  async function saveSizes(next: CropSize[]) { try { setSaved(await api.saveCropSizes(next)); } catch (error) { setError(errorText(error)); } }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      else if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); applyCrop(); }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  });

  const presets = saved.filter(size => !size.isAspectRatio && !size.cropRect).sort((a, b) => area(a) - area(b));
  const hasSize = saved.some(size => size.width === pixelWidth && size.height === pixelHeight);
  const orientationPicker = <div className="segmented" role="group" aria-label="Orientation">
    {(pdf ? ['portrait', 'adaptive', 'landscape'] as const : ['portrait', 'landscape'] as const).map(value => <button key={value} aria-pressed={orientation === value} className={orientation === value ? 'active' : ''} title={value === 'adaptive' ? 'Crop every page to the size, keeping its own orientation' : `Crop to a ${value} orientation`} onClick={() => changeOrientation(value)}><OrientationIcon value={value}/></button>)}
  </div>;
  const groupPicker = (label: string, list: 'paper' | 'device', categories: { category: string; groups: CropSizeGroup[] }[], style: Frame) =>
    <select aria-label={label} value={adaptiveAspect?.list === list ? adaptiveAspect.name : ''} onChange={event => { const group = categories.flatMap(c => c.groups).find(g => g.name === event.target.value); if (group) applyAspectPreset(groupSize(group), style, list); else unlockAspect(); }}>
      <option value="">No selection</option>
      {categories.map(c => <optgroup key={c.category} label={c.category}>{c.groups.map(g => <option key={g.name} value={g.name} title={g.summary ?? g.members.join(', ')}>{g.name}</option>)}</optgroup>)}
    </select>;

  return <div className="view-window crop-window">
    <div className="crop-main">
      {source ? <Preview source={source} space={space} extending={extending} rect={rect} aspect={lockedAspect} frame={frame} label={presetName} unit={unit} output={output}
        onChange={next => { setRect(next); setRectEdited(true); }} onReset={reset}/> : <div className="view-loading">{error || <span className="spinner"/>}</div>}
      <div className="preview-bar">
        {pdf && source?.pages && source.pages > 1 && <><button aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button><span>Page {source.page} of {source.pages}</span><button aria-label="Next page" disabled={page >= source.pages} onClick={() => setPage(page + 1)}>›</button></>}
        {kind === 'video' && <label className="frame-slider" title="Choose the video frame used for the crop preview"><span>Frame</span><input type="range" min="0" max="1" step="0.001" value={time} onChange={event => setTime(Number(event.target.value))}/></label>}
      </div>
    </div>
    <aside className="crop-sidebar">
      <div className="sidebar-scroll">
        {pdf ? <section>
          <h2>Paper size</h2>{groupPicker('Paper size', 'paper', PAPER_SIZE_GROUPS, 'paper')}
          <h2>Device size</h2>{groupPicker('Device size', 'device', DEVICE_SIZE_GROUPS, 'device')}
          <h2>Aspect ratio</h2>
          <select aria-label="Aspect ratio" value={adaptiveAspect?.list === 'ratio' ? adaptiveAspect.name : ''} onChange={event => { const size = PDF_RATIOS.find(s => s.name === event.target.value); if (size) applyAspectPreset(size, 'plain', 'ratio'); else unlockAspect(); }}>
            <option value="">No selection</option>{PDF_RATIOS.map(size => <option key={size.name} value={size.name}>{size.name}</option>)}
          </select>
          <div className="row">{orientationPicker}</div>
          <label className="check" title="Grows pages with empty paper instead of cutting content away, to fit a book page on a phone screen without losing text at the edges."><input type="checkbox" checked={extend} onChange={event => toggleExtend(event.target.checked)}/>Extend instead of clipping</label>
          {source?.uncropped && <button className="link-button" disabled={busy} onClick={() => void run({ type: 'pdf-uncrop' }, true)}>Uncrop to {Math.round(source.uncropped.width)}×{Math.round(source.uncropped.height)}</button>}
        </section> : <>
          <section>
            <div className="section-head"><h2>Aspect ratio</h2>{orientationPicker}</div>
            <div className="chips">
              <button className={`chip ${lockedAspect === undefined ? 'active' : ''}`} onClick={unlockAspect}><span className="free-icon"/>Free</button>
              {DEFAULT_CROP_ASPECT_RATIOS.map(size => { const turned = oriented(size, orientation, sourceSize); return <button key={size.name} className={`chip ${presetName === size.name ? 'active' : ''}`} onClick={() => applyAspectPreset({ ...size, ...turned })}><AspectIcon aspect={turned.width / turned.height}/>{size.name}</button>; })}
            </div>
          </section>
          <section>
            <h2>Size presets</h2>
            <div className="presets">{presets.map(size => { const resolved = computedSize(size, sourceSize.width, sourceSize.height); return <div key={`${sizeId(size)}-${size.name}`} className={`preset ${presetName === size.name && target ? 'active' : ''}`}>
              <button disabled={size.width > sourceSize.width || size.height > sourceSize.height} onClick={() => applySizePreset(size)}><AspectIcon aspect={resolved.height > 0 ? resolved.width / resolved.height : 1}/><span className="name">{size.name}</span><small>{sizeId(size)}</small></button>
              <button className="delete" aria-label={`Delete ${size.name}`} title="Delete preset" onClick={() => void saveSizes(saved.filter(other => other !== size))}>×</button>
            </div>; })}</div>
            {!hasSize && <form className="save-size" onSubmit={event => { event.preventDefault(); if (saveName.trim() && pixelWidth > 0 && pixelHeight > 0) { void saveSizes([...saved, { width: pixelWidth, height: pixelHeight, name: saveName.trim(), longEdge: false, smartCrop: false }]); setSaveName(''); } }}>
              <input value={saveName} maxLength={100} placeholder={`Save ${pixelWidth}×${pixelHeight} as…`} onChange={event => setSaveName(event.target.value)}/><button type="submit" aria-label="Save size" disabled={!saveName.trim()}>+</button>
            </form>}
            {!DEFAULT_CROP_SIZES.every(size => saved.some(other => same(size, other))) && <button className="link-button" onClick={() => void saveSizes([...DEFAULT_CROP_SIZES, ...saved.filter(size => !DEFAULT_CROP_SIZES.some(other => same(size, other)))])}>Bring back default sizes</button>}
          </section>
        </>}
      </div>
      {error && source && <p className="view-error" role="alert">{error}</p>}
      <div className="dimensions">
        <input aria-label="Width" type="number" min="1" value={pixelWidth} onChange={event => setPixelSize(event.target.value, 'width')}/><span>×</span>
        <input aria-label="Height" type="number" min="1" value={pixelHeight} onChange={event => setPixelSize(event.target.value, 'height')}/><small>{unit}</small>
        {!pdf && lockedAspect !== undefined && <button className="lock" aria-label="Unlock aspect ratio" title="Aspect ratio locked, click to unlock" onClick={unlockAspect}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5" width="8" height="6" rx="1.2" fill="currentColor"/><path d="M4 5V3.5a2 2 0 0 1 4 0V5" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg></button>}
      </div>
      <div className="crop-actions"><button onClick={reset}>Reset</button><button className="primary" disabled={busy || nothingToCrop || !source} title="Ctrl+Enter" onClick={applyCrop}>{title}</button></div>
    </aside>
  </div>;
}

function AspectIcon({ aspect }: { aspect: number }) {
  const w = Math.min(16, 10 * aspect), h = w / aspect;
  return <span className="aspect-icon"><span style={{ width: Math.max(w, 3), height: Math.max(Math.min(h, 10), 3) }}/></span>;
}
function OrientationIcon({ value }: { value: CropOrientation }) {
  return <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">{value === 'portrait' ? <rect x="4.5" y="1" width="7" height="10" rx="1.5"/> : value === 'landscape' ? <rect x="1.5" y="2.5" width="13" height="7" rx="1.5"/> : <><rect x="1" y="3" width="7" height="6" rx="1"/><rect x="9" y="1" width="6" height="10" rx="1"/></>}<title>{value[0].toUpperCase() + value.slice(1)}</title></svg>;
}

interface PreviewProps { source: CropSource; space: Size; extending: boolean; rect: CropRect; aspect?: number; frame: Frame; label?: string; unit: string; output: Size; onChange: (rect: CropRect) => void; onReset: () => void }
/** The picture fitted in the window, with the selection over it (`CropSelectionOverlay`). Extending shows the page on its grown white canvas. */
function Preview({ source, space, extending, rect, aspect, frame, label, unit, output, onChange, onReset }: PreviewProps) {
  const area = useRef<HTMLDivElement>(null), [box, setBox] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const element = area.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const view = box.width && box.height ? fit(space, box) : undefined;
  const picture = view && (extending ? { width: source.width * view.scale, height: source.height * view.scale } : view);
  return <div className="crop-preview" ref={area}>
    {view && picture && <div className={`crop-canvas ${extending ? 'extended' : ''}`} style={{ width: view.width, height: view.height }}>
      <img src={source.preview} alt="" draggable={false} style={{ width: picture.width, height: picture.height }}/>
      <Selection view={view} rect={rect} space={space} aspect={aspect} frame={frame} label={label} unit={unit} output={output} preview={extending ? undefined : source.preview} onChange={onChange} onReset={onReset}/>
    </div>}
  </div>;
}

type Drag = { kind: 'move' | 'marquee' | Handle; start: Box; x: number; y: number };
function Selection({ view, rect, space, aspect, frame, label, unit, output, preview, onChange, onReset }: { view: Size; rect: CropRect; space: Size; aspect?: number; frame: Frame; label?: string; unit: string; output: Size; preview?: string; onChange: (rect: CropRect) => void; onReset: () => void }) {
  const root = useRef<HTMLDivElement>(null), drag = useRef<Drag>(undefined), [interacting, setInteracting] = useState(false);
  const b = toBox(rect, view), radius = frame === 'device' ? Math.min(Math.max(Math.min(b.width, b.height) * 0.08, 6), 26) : frame === 'paper' ? 0.5 : 2;
  const selection = selectionSize(rect, space), scaled = Math.round(output.width) !== Math.round(selection.width) || Math.round(output.height) !== Math.round(selection.height);
  const factor = selection.width > 0 ? output.width / selection.width : 1;
  const point = (event: PointerEvent) => { const bounds = root.current!.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }; };
  function start(event: PointerEvent, kind: Drag['kind']) {
    if (event.button !== 0) return;
    event.stopPropagation(); event.preventDefault();
    root.current!.setPointerCapture(event.pointerId);
    drag.current = { kind, start: b, ...point(event) };
  }
  function move(event: PointerEvent) {
    const d = drag.current; if (!d) return;
    const p = point(event), dx = p.x - d.x, dy = p.y - d.y;
    if (!interacting && Math.hypot(dx, dy) < (d.kind === 'marquee' ? 4 : 1)) return;
    setInteracting(true);
    const next = d.kind === 'move' ? moved(d.start, dx, dy, view) : d.kind === 'marquee' ? marquee({ x: d.x, y: d.y }, p, view, aspect) : resized(d.start, d.kind, dx, dy, view, aspect);
    if (next) onChange(toRect(next, view));
  }
  function end() { drag.current = undefined; setInteracting(false); }
  const thirds = [1 / 3, 2 / 3];
  return <div className="selection-layer" ref={root} onPointerDown={event => start(event, 'marquee')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
    <svg className="dimming" width={view.width} height={view.height}><path fillRule="evenodd" fill={`rgba(0,0,0,${interacting ? .55 : .45})`} d={`M0 0H${view.width}V${view.height}H0Z M${b.x + radius} ${b.y}H${b.x + b.width - radius}A${radius} ${radius} 0 0 1 ${b.x + b.width} ${b.y + radius}V${b.y + b.height - radius}A${radius} ${radius} 0 0 1 ${b.x + b.width - radius} ${b.y + b.height}H${b.x + radius}A${radius} ${radius} 0 0 1 ${b.x} ${b.y + b.height - radius}V${b.y + radius}A${radius} ${radius} 0 0 1 ${b.x + radius} ${b.y}Z`}/>
      {interacting && thirds.map(f => <g key={f} stroke="rgba(255,255,255,.4)"><line x1={b.x + b.width * f} y1={b.y} x2={b.x + b.width * f} y2={b.y + b.height}/><line x1={b.x} y1={b.y + b.height * f} x2={b.x + b.width} y2={b.y + b.height * f}/></g>)}
    </svg>
    <div className={`selection-frame ${frame}`} style={{ left: b.x, top: b.y, width: b.width, height: b.height, borderRadius: radius }}/>
    {preview && !interacting && factor <= 0.7 && b.width * factor >= 20 && b.height * factor >= 20 && <div className="result-size" style={{ left: b.x + b.width / 2 - b.width * factor / 2, top: b.y + b.height / 2 - b.height * factor / 2, width: b.width * factor, height: b.height * factor }}>
      <img src={preview} alt="" style={{ width: view.width * factor, height: view.height * factor, left: -b.x * factor, top: -b.y * factor }}/>
    </div>}
    <div className="move-area" style={{ left: b.x, top: b.y, width: Math.max(b.width, 1), height: Math.max(b.height, 1) }} onPointerDown={event => start(event, 'move')} onDoubleClick={onReset}/>
    {HANDLES.map(handle => { const p = handlePoint(handle, b); return <div key={handle} className={`handle ${handle}`} style={{ left: p.x, top: p.y }} onPointerDown={event => start(event, handle)}><span/></div>; })}
    <span className="badge size" style={{ left: b.x + b.width / 2, top: Math.min(b.y + b.height + 14, view.height - 10) }}>{Math.round(selection.width)}×{Math.round(selection.height)}{scaled ? ` → ${Math.round(output.width)}×${Math.round(output.height)}` : ''} {unit}</span>
    {label && <span className="badge label" style={{ left: b.x + b.width / 2, top: Math.max(b.y - 14, 10) }}>{label}</span>}
  </div>;
}
