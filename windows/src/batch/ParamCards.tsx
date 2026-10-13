import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_CROP_ASPECT_RATIOS } from '../../core/data/cropSizes';
import { batchCrop, flipped, withOrientation, type CropOrientation } from '../../core/batch/crop';
import type { CropSpec } from '../../core/media/crop-size';
import type { MediaKind } from '../../core/media/types';
import type { CropSize } from '../../core/settings/schema';
import type { AudioFormatOption, BatchParams } from './types';

// The parameter cards of BatchPrepView.swift (BatchParamColumns, OutputRow) and the crop presets of BatchCropButton.swift.

type Set_<T> = (change: Partial<T>) => void;
export interface CardsProps { params: BatchParams; onChange: (params: BatchParams) => void; present: ReadonlySet<MediaKind>; cropSizes: CropSize[]; audioFormats: AudioFormatOption[]; chooseFolder: () => Promise<string | undefined> }

function Card({ title, dimmed, children }: { title: string; dimmed: boolean; children: ReactNode }) {
  return <section className={`param-card ${dimmed ? 'dimmed' : ''}`} aria-label={`${title} parameters`}><h2>{title}</h2><fieldset disabled={dimmed}>{children}</fieldset></section>;
}
function Row({ label, disabled = false, children }: { label: string; disabled?: boolean; children: ReactNode }) {
  return <div className={`param-row ${disabled ? 'disabled' : ''}`} role="group" aria-label={label}><span>{label}</span><fieldset disabled={disabled}>{children}</fieldset></div>;
}
function Toggle({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <label className={`param-row toggle ${disabled ? 'disabled' : ''}`}><span>{label}</span><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/></label>;
}
function Choice<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void }) {
  return <select aria-label={label} value={String(value)} onChange={event => onChange(options.find(([option]) => String(option) === event.target.value)![0])}>{options.map(([option, title]) => <option key={String(option)} value={String(option)}>{title}</option>)}</select>;
}
/** A slider that commits on release, like the CommitSliders, so dragging never re-renders the table. */
function Slider({ label, value, min, max, step = 1, format, onChange }: { label: string; value: number; min: number; max: number; step?: number; format: (value: number) => string; onChange: (value: number) => void }) {
  const [drag, setDrag] = useState<number>();
  const commit = () => { if (drag !== undefined) { onChange(drag); setDrag(undefined); } };
  return <span className="slider"><input type="range" aria-label={label} min={min} max={max} step={step} value={drag ?? value} onChange={event => setDrag(Number(event.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit}/><output>{format(drag ?? value)}</output></span>;
}
function NumberField({ label, value, suffix, min = 0, max = 16383, onChange }: { label: string; value: number | undefined; suffix: string; min?: number; max?: number; onChange: (value: number | undefined) => void }) {
  return <span className="number-field"><input type="number" aria-label={label} min={min} max={max} value={value ?? ''} placeholder="Off" onChange={event => { const n = Math.round(Number(event.target.value)); onChange(event.target.value && n > 0 ? Math.min(n, max) : undefined); }}/><small>{suffix}</small></span>;
}

// Downscale slider: 0 keeps the size, 1 scales to 0.05× (BatchParamsModel.factor and sliderPos).
const toFactor = (slider: number) => { const f = Math.round((1 - slider * 0.95) * 100) / 100; return f < 0.999 ? f : undefined; };
const toSlider = (factor?: number) => factor && factor < 0.999 ? Math.min(Math.max((1 - factor) / 0.95, 0), 1) : 0;
const compression = (label: string, value: number, onChange: (value: number) => void) => <Slider label={label} value={value} min={0} max={100} format={String} onChange={onChange}/>;
const downscale = (label: string, factor: number | undefined, onChange: (factor: number | undefined) => void) => <Slider label={label} value={toSlider(factor)} min={0} max={1} step={0.01} format={s => `${(1 - s * 0.95).toFixed(2)}×`} onChange={s => onChange(toFactor(s))}/>;
/** The common bitrates a bitrate slider snaps to within 3 kbps (snapBitrate). */
function snapBitrate(value: number, range: { lo: number; hi: number }) {
  if (value <= 0) return 0;
  const clamped = Math.max(range.lo, Math.min(range.hi, value));
  const near = [32, 48, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320].filter(b => b >= range.lo && b <= range.hi).sort((a, b) => Math.abs(a - clamped) - Math.abs(b - clamped))[0];
  return near !== undefined && Math.abs(near - clamped) <= 3 ? near : clamped;
}

/** How a crop reads on its button: `16:9 · adaptive`, `9:16`, `1080p · 1920×1080` or `800×Auto`. */
export function cropLabel(crop: CropSpec | undefined, sizes: readonly CropSize[]) {
  if (!crop) return 'None';
  const sides = `${crop.width || 'Auto'}×${crop.height || 'Auto'}`;
  if (!crop.isAspectRatio) { const saved = sizes.find(size => !size.isAspectRatio && ((size.width === crop.width && size.height === crop.height) || (size.width === crop.height && size.height === crop.width))); return saved ? `${saved.name} · ${sides}` : sides; }
  const ratio = DEFAULT_CROP_ASPECT_RATIOS.find(size => (size.width === crop.width && size.height === crop.height) || (size.width === crop.height && size.height === crop.width));
  const name = !ratio ? `${crop.width}:${crop.height}` : ratio.width === crop.width ? ratio.name : flipped(ratio).name;
  return crop.longEdge ? `${name} · adaptive` : name;
}

/** BatchCropButton: saved sizes, aspect ratios and a custom size, each turned portrait, landscape or adaptive. PDFs take aspect ratios only. */
function CropPicker({ label, value, onChange, sizes, ratiosOnly = false }: { label: string; value?: CropSpec; onChange: (crop: CropSpec | undefined) => void; sizes: readonly CropSize[]; ratiosOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const [orientation, setOrientation] = useState<CropOrientation>(value?.longEdge ? 'adaptive' : value && value.width < value.height ? 'portrait' : value ? 'landscape' : 'adaptive');
  const [preset, setPreset] = useState<CropSize>();
  const [custom, setCustom] = useState({ width: '', height: '' });
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!panel.current?.parentElement?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  const choose = (size: CropSize, turn = orientation) => { setPreset(size); onChange(batchCrop(size, turn)); };
  const turn = (next: CropOrientation) => { setOrientation(next); if (preset) choose(preset, next); };
  const selected = (size: CropSize) => !!value && !!preset && preset.name === size.name && preset.width === size.width && preset.height === size.height;
  const exact = sizes.filter(size => !size.isAspectRatio).map(size => withOrientation(size, orientation)).sort((a, b) => a.width * a.height - b.width * b.height);
  const applyCustom = () => { const width = Math.round(Number(custom.width)) || 0, height = Math.round(Number(custom.height)) || 0; if (width > 0 || height > 0) choose({ width, height, name: '', longEdge: false, smartCrop: false }, 'landscape'); };
  return <span className="crop-picker">
    <button type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>{cropLabel(value, sizes)}</button>
    {open && <div className="crop-panel" ref={panel} role="dialog" aria-label={label}>
      <div className="segmented" role="radiogroup" aria-label="Orientation">{(['portrait', 'adaptive', 'landscape'] as const).map(o => <button type="button" key={o} role="radio" aria-checked={orientation === o} className={orientation === o ? 'active' : ''} title={o === 'adaptive' ? 'Keep each file\'s own orientation' : `Crop every file to ${o}`} onClick={() => turn(o)}>{o[0].toUpperCase() + o.slice(1)}</button>)}</div>
      {!ratiosOnly && <><h3>Size presets</h3><div className="preset-list">{exact.map(size => <button type="button" key={`${size.name}${size.width}`} className={selected(size) ? 'active' : ''} onClick={() => choose(size)}><span>{size.name}</span><small>{size.width}×{size.height}</small></button>)}</div></>}
      <h3>Aspect ratios</h3>
      <div className="ratio-grid">{DEFAULT_CROP_ASPECT_RATIOS.map(size => { const shown = withOrientation(size, orientation); return <button type="button" key={size.name} className={selected(size) ? 'active' : ''} onClick={() => choose(size)}>{shown.name}</button>; })}</div>
      {!ratiosOnly && <form className="custom-size" onSubmit={event => { event.preventDefault(); applyCustom(); }}><input aria-label="Crop width" type="number" min="0" max="16383" placeholder="Width" value={custom.width} onChange={event => setCustom({ ...custom, width: event.target.value })}/><span>×</span><input aria-label="Crop height" type="number" min="0" max="16383" placeholder="Height" value={custom.height} onChange={event => setCustom({ ...custom, height: event.target.value })}/><button type="submit">Use size</button></form>}
      <div className="crop-actions"><button type="button" onClick={() => { setPreset(undefined); onChange(undefined); }}>No crop</button><button type="button" onClick={() => setOpen(false)}>Done</button></div>
    </div>}
  </span>;
}

const IMAGE_FORMATS = [['', 'Keep format'], ['jpeg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP'], ['jxl', 'JPEG XL']] as const;
const VIDEO_FORMATS = [['', 'Keep format'], ['mp4', 'MP4'], ['hevc', 'HEVC'], ['av1', 'AV1'], ['webm', 'WebM']] as const;
const ENCODERS = [['adaptive', 'Adaptive'], ['fast', 'Faster'], ['smaller', 'Smaller file'], ['lossless', 'Visually lossless']] as const;
const DPIS = [['adaptive', 'Adaptive'], ...[300, 250, 200, 150, 100, 72, 48].map(dpi => [dpi, `${dpi} DPI`] as const), ['stepDown', 'Step down per file']] as const;
const LOUDNESS = [[0, 'No normalisation'], [-14, 'Streaming (−14 LUFS)'], [-16, 'Apple Music (−16)'], [-19, 'Podcast (−19)'], [-23, 'Broadcast (−23)']] as const;
const COVERS = [['optimise', 'Optimise'], ['remove', 'Remove'], ['keep', 'Keep']] as const;
const SQUARING = [['landscapeOnly', 'Square if landscape'], ['always', 'Square'], ['never', 'Long edge']] as const;

export function ParamCards({ params, onChange, present, cropSizes, audioFormats, chooseFolder }: CardsProps) {
  const { image, video, pdf, audio } = params;
  const [fps, setFps] = useState(video.fps ?? 60);
  const set = <K extends 'image' | 'video' | 'pdf' | 'audio'>(kind: K): Set_<BatchParams[K]> => change => onChange({ ...params, [kind]: strip({ ...params[kind], ...change }) });
  const setImage = set('image'), setVideo = set('video'), setPDF = set('pdf'), setAudio = set('audio');
  const format = audioFormats.find(f => f.format === audio.format), lossless = !!format?.lossless, range = format?.bitrates ?? { lo: 32, hi: 320 };
  const coverDisabled = !!format && !format.coverArt;
  return <div className="param-columns">
    <OutputRow params={params} onChange={onChange} chooseFolder={chooseFolder}/>
    <div className="cards">
      <div className="card-column">
        <Card title="Images" dimmed={!present.has('image')}>
          <Row label="Compression">{compression('Image compression', image.compression, value => setImage({ compression: value }))}</Row>
          <Row label="Convert to"><Choice label="Image format" value={image.convert ?? ''} options={IMAGE_FORMATS} onChange={value => setImage({ convert: value || undefined })}/></Row>
          <Row label="Downscale" disabled={!!image.maxLongEdge || !!image.crop}>{downscale('Image downscale', image.downscale, value => setImage({ downscale: value }))}</Row>
          <Row label="Max long edge" disabled={!!image.downscale || !!image.crop}><NumberField label="Image max long edge" value={image.maxLongEdge} suffix="px" onChange={value => setImage({ maxLongEdge: value })}/></Row>
          <Row label="Crop"><CropPicker label="Image crop" value={image.crop} sizes={cropSizes} onChange={crop => setImage({ crop })}/></Row>
          <Toggle label="Adaptive (PNG ↔ JPEG)" checked={image.adaptive} onChange={value => setImage({ adaptive: value })}/>
          <Toggle label="Keep if larger" checked={image.allowLarger} disabled={!image.convert} onChange={value => setImage({ allowLarger: value })}/>
        </Card>
        <Card title="PDF" dimmed={!present.has('pdf')}>
          <Row label="Resolution"><Choice label="PDF resolution" value={pdf.dpi} options={DPIS} onChange={dpi => setPDF({ dpi })}/></Row>
          <Row label="Crop"><CropPicker label="PDF crop" value={pdf.crop} sizes={cropSizes} ratiosOnly onChange={crop => setPDF({ crop })}/></Row>
        </Card>
      </div>
      <Card title="Video" dimmed={!present.has('video')}>
        <Row label="Compression" disabled={video.encoder === 'lossless'}>{compression('Video compression', video.compression, value => setVideo({ compression: value }))}</Row>
        <Row label="Convert to"><Choice label="Video format" value={video.convert ?? ''} options={VIDEO_FORMATS} onChange={value => setVideo({ convert: value || undefined })}/></Row>
        <Row label="Downscale" disabled={!!video.maxLongEdge || !!video.crop}>{downscale('Video downscale', video.downscale, value => setVideo({ downscale: value }))}</Row>
        <Row label="Max long edge" disabled={!!video.downscale || !!video.crop}><NumberField label="Video max long edge" value={video.maxLongEdge} suffix="px" onChange={value => setVideo({ maxLongEdge: value })}/></Row>
        <Row label="Crop"><CropPicker label="Video crop" value={video.crop} sizes={cropSizes} onChange={crop => setVideo({ crop })}/></Row>
        <Row label="Encoder"><Choice label="Video encoder" value={video.encoder} options={ENCODERS} onChange={encoder => setVideo({ encoder })}/></Row>
        <Row label="Frame rate"><span className="fps"><NumberField label="Frame rate cap" value={fps} suffix="fps" max={240} onChange={value => { setFps(value ?? 60); if (video.fps) setVideo({ fps: value }); }}/><input type="checkbox" role="switch" aria-label="Cap the frame rate" checked={!!video.fps} onChange={event => setVideo({ fps: event.target.checked ? fps : undefined })}/></span></Row>
        <Toggle label="Remove audio" checked={video.removeAudio} onChange={value => setVideo({ removeAudio: value })}/>
        <Toggle label="Keep if larger" checked={video.allowLarger} disabled={!video.convert} onChange={value => setVideo({ allowLarger: value })}/>
      </Card>
      <Card title="Audio" dimmed={!present.has('audio')}>
        <Row label="Compression" disabled={lossless || !!audio.bitrate}>{compression('Audio compression', audio.compression, value => setAudio({ compression: value }))}</Row>
        <Row label="Format"><Choice label="Audio format" value={audio.format ?? ''} options={[['', 'Keep format'], ...audioFormats.map(f => [f.format, f.format === 'opus' ? 'Opus' : f.format.toUpperCase()] as const)]} onChange={value => {
          const next = audioFormats.find(f => f.format === value);
          setAudio({ format: value || undefined, bitrate: audio.bitrate && next?.bitrates ? snapBitrate(audio.bitrate, next.bitrates) : next?.lossless ? undefined : audio.bitrate });
        }}/></Row>
        <Row label="Bitrate" disabled={lossless}><Slider label="Audio bitrate" value={audio.bitrate ?? 0} min={0} max={range.hi} step={2} format={value => { const kbps = snapBitrate(value, range); return kbps ? `${kbps}` : 'Auto'; }} onChange={value => setAudio({ bitrate: snapBitrate(value, range) || undefined })}/></Row>
        <Row label="Loudness"><Choice label="Loudness" value={audio.loudnorm ?? 0} options={LOUDNESS} onChange={value => setAudio({ loudnorm: value || undefined })}/></Row>
        <Row label="Cover art" disabled={coverDisabled}><Choice label="Cover art" value={audio.coverArt} options={COVERS} onChange={coverArt => setAudio({ coverArt })}/></Row>
        <Row label="Cover size" disabled={coverDisabled || audio.coverArt !== 'optimise'}><span className="cover-size"><NumberField label="Cover art long edge" value={audio.coverArtMaxLongEdge} suffix="px" onChange={value => setAudio({ coverArtMaxLongEdge: value })}/><Choice label="Cover art shape" value={audio.coverArtSquaring} options={SQUARING} onChange={coverArtSquaring => setAudio({ coverArtSquaring })}/></span></Row>
        <Toggle label="Convert WAV / AIFF / FLAC" checked={audio.convertLossless} onChange={value => setAudio({ convertLossless: value })}/>
        <Toggle label="Keep if larger" checked={audio.allowLarger} disabled={!audio.format} onChange={value => setAudio({ allowLarger: value })}/>
      </Card>
    </div>
  </div>;
}
/** Drops fields set to undefined, so a cleared choice leaves the parameters as the main process expects them. */
const strip = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** OutputRow: in place, next to the original under a name template, or in a chosen folder under a name template. */
function OutputRow({ params, onChange, chooseFolder }: Pick<CardsProps, 'params' | 'onChange' | 'chooseFolder'>) {
  const output = params.output;
  const [templates, setTemplates] = useState({ sameFolder: output.location === 'sameFolder' ? output.template : '%f-optimised', folder: output.location === 'folder' ? output.template : '%f' });
  const [folder, setFolder] = useState(output.location === 'folder' ? output.folder : '');
  const set = (next: BatchParams['output']) => onChange({ ...params, output: next });
  async function pick(location: BatchParams['output']['location']) {
    if (location === 'inPlace') set({ location });
    else if (location === 'sameFolder') set({ location, template: templates.sameFolder });
    else { const chosen = await chooseFolder(); if (chosen) { setFolder(chosen); set({ location, folder: chosen, template: templates.folder }); } }
  }
  const template = (value: string) => {
    if (output.location === 'sameFolder') { setTemplates({ ...templates, sameFolder: value }); set({ ...output, template: value }); }
    else if (output.location === 'folder') { setTemplates({ ...templates, folder: value }); set({ ...output, template: value }); }
  };
  return <div className="output-row">
    <label>Save to <Choice label="Save to" value={output.location} options={[['inPlace', 'In place'], ['sameFolder', 'Next to the original'], ['folder', folder ? 'In folder' : 'In folder…']]} onChange={location => void pick(location)}/></label>
    {output.location === 'folder' && <><span className="folder" title={folder}>{folder.split(/[\\/]/).pop()}</span><button type="button" onClick={() => void pick('folder')}>Change…</button></>}
    {output.location !== 'inPlace' && <label>Name <input aria-label="Name template" value={output.template} spellCheck={false} onChange={event => template(event.target.value)}/></label>}
    <small>{output.location === 'inPlace' ? 'Originals are moved to the batch backups, so the whole batch can be reverted.' : '%f is the file name, %i a number, %y-%m-%d the date.'}</small>
  </div>;
}
