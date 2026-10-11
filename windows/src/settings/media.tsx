import type { CompressionQuality } from '../../core/settings/schema';
import { useSettings } from './context';
import { Chip, NumberField, ResolutionField, Switch, useDraft } from './inputs';
import { FPS_CAPS, MIN_FPS, PDF_DPI_PRESETS } from './options';

type CompressionKey = 'imageCompression' | 'videoCompression' | 'audioCompression';
type Tier = CompressionQuality['tier'];
interface TierChoice { tier: Tier; label: string; hint: string }

// Image and video offer the tiers of the macOS panes (`images`: Adaptive or a factor; `video`: Adaptive, Visually lossless, Hardware, Software), and
// Windows adds a lossless image tier that changes no pixels. Audio is a factor only.
const TIERS: Record<CompressionKey, TierChoice[]> = {
  imageCompression: [
    { tier: 'adaptive', label: 'Adaptive', hint: 'Clop picks JPEG or PNG from how detailed the image is and chooses a fitting compression factor.' },
    { tier: 'custom', label: 'Factor', hint: '' },
    { tier: 'lossless', label: 'Lossless', hint: 'Changes no pixels. Files shrink less than with a factor.' },
  ],
  videoCompression: [
    { tier: 'adaptive', label: 'Adaptive', hint: 'Picks the best encoder and amount of compression for each file.' },
    { tier: 'lossless', label: 'Visually lossless', hint: 'No perceptible quality loss.' },
    { tier: 'fast', label: 'Hardware encoder', hint: 'Fast and light on the CPU, modest size gains.' },
    { tier: 'smaller', label: 'Software encoder', hint: '' },
  ],
  audioCompression: [],
};

/** Compression of one file type: a tier where the type has them, and the factor from better quality (5) to a smaller file (100). */
export function Compression({ settingKey }: { settingKey: CompressionKey }) {
  const { settings, change } = useSettings();
  const value = settings[settingKey];
  const tiers = TIERS[settingKey], video = settingKey === 'videoCompression';
  // Video's `custom` (macOS imports) reads as the software encoder.
  const tier: Tier = video && value.tier === 'custom' ? 'smaller' : value.tier;
  const usesFactor = settingKey === 'audioCompression' || (video ? tier === 'smaller' : tier === 'custom');
  const auto = video && usesFactor && value.factor === 0;
  const { draft, edit } = useDraft(auto ? 50 : Math.max(5, value.factor), factor => change({ [settingKey]: { tier: video ? 'smaller' : tier, factor } }), 300);
  const hint = tiers.find(choice => choice.tier === tier)?.hint;
  return <div className="compression">
    {tiers.length > 0 && <div className="chips" role="group" aria-label="Compression mode">
      {tiers.map(choice => <Chip key={choice.tier} on={choice.tier === tier} onClick={() => change({ [settingKey]: { tier: choice.tier, factor: value.factor } })}>{choice.label}</Chip>)}
    </div>}
    {usesFactor && <div className="slider-row">
      {video && <Chip on={auto} title="The encoder chooses the compression factor from the video's contents" onClick={() => change({ [settingKey]: { tier: 'smaller', factor: auto ? Math.max(5, draft) : 0 } })}>Auto</Chip>}
      <small>Better quality</small>
      <input type="range" min={5} max={100} step={1} aria-label="Compression factor" value={draft} disabled={auto} onChange={event => edit(Number(event.target.value))}/>
      <small>Smaller size</small>
      <output className={auto ? 'faded' : ''}>{draft}%</output>
    </div>}
    {auto && <small>The encoder chooses the compression factor from the video's contents.</small>}
    {hint && <small>{hint}</small>}
  </div>;
}

/** PDF image resolution: Auto picks a DPI per PDF, or choose one (48 to 300). */
export function PdfDpi() {
  const { settings, change } = useSettings();
  const dpi = settings.pdfDPI;
  return <div className="compression">
    <div className="chips" role="group" aria-label="PDF image resolution">
      {PDF_DPI_PRESETS.map(preset => <Chip key={preset} on={dpi === preset} onClick={() => change({ pdfDPI: preset })}>{preset === 0 ? 'Auto' : `${preset} dpi`}</Chip>)}
      <NumberField label="Custom DPI" value={dpi} min={0} max={300} unit="dpi" accept={value => value === 0 || value >= 48} onCommit={value => change({ pdfDPI: value })}/>
    </div>
    <small>{dpi === 0 ? 'Clop picks a DPI for each PDF from the density of its images and downscales them to fit.' : `Images in PDFs are downscaled to ${dpi} dpi.`}</small>
  </div>;
}

const size = (kb: number) => kb >= 1_000_000 ? `${(kb / 1_000_000).toFixed(1)} GB` : kb >= 1000 ? `${Math.round(kb / 1000)} MB` : `${kb} KB`;
/** The size window of watched files: smallest in KB and largest in MB, 0 for no bound. */
export function SizeRange({ keys }: { keys: readonly string[] }) {
  const { settings, change } = useSettings();
  const [minKey, maxKey] = keys as [keyof typeof settings, keyof typeof settings];
  const min = settings[minKey] as number, max = settings[maxKey] as number;
  const caption = min && max ? `Only optimises files between ${size(min)} and ${size(max * 1000)}` : min ? `Only optimises files larger than ${size(min)}` : max ? `Only optimises files smaller than ${size(max * 1000)}` : 'Optimises files of any size';
  return <div className="range">
    <NumberField label="Smallest file" value={min} max={100_000_000} unit="KB" onCommit={value => change({ [minKey]: value })}/><span className="to">to</span>
    <NumberField label="Largest file" value={max} max={100_000} unit="MB" onCommit={value => change({ [maxKey]: value })}/>
    <small>{caption}</small>
  </div>;
}

/** The pixel window of watched files: smallest and largest width or height, 0 for no bound. */
export function ResolutionRange({ keys }: { keys: readonly string[] }) {
  const { settings, change } = useSettings();
  const [minKey, maxKey] = keys as [keyof typeof settings, keyof typeof settings];
  const min = settings[minKey] as number, max = settings[maxKey] as number;
  const caption = min && max ? `Only optimises files between ${min} and ${max} px` : min ? `Only optimises files larger than ${min} px` : max ? `Only optimises files smaller than ${max} px` : 'Optimises files of any resolution';
  return <div className="range">
    <ResolutionField label="Smallest width or height" value={min} onCommit={value => change({ [minKey]: value })}/><span className="to">to</span>
    <ResolutionField label="Largest width or height" value={max} onCommit={value => change({ [maxKey]: value })}/>
    <small>{caption}</small>
  </div>;
}

/** Cap the frame rate: off, or at 30 or 60 fps, or at a half or quarter of the source's. */
export function FpsCap() {
  const { settings, change } = useSettings();
  const target = settings.targetVideoFPS;
  return <div className="compression">
    <div className="chips">
      <Switch label="Cap frames per second" checked={settings.capVideoFPS} onChange={value => change({ capVideoFPS: value })}/><small>Cap at</small>
      {FPS_CAPS.map(cap => <Chip key={cap.value} on={target === cap.value} onClick={() => change({ targetVideoFPS: cap.value })}>{cap.label}</Chip>)}
    </div>
  </div>;
}

export function MinFps() {
  const { settings, change } = useSettings();
  return <div className="chips" role="group" aria-label="Lowest frame rate">{MIN_FPS.map(fps => <Chip key={fps} on={settings.minVideoFPS === fps} onClick={() => change({ minVideoFPS: fps })}>{fps} fps</Chip>)}</div>;
}
