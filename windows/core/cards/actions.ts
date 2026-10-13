import { makeStep, type PipelineStep } from '../pipeline/model';
import type { MediaKind } from '../media/types';

// The action table behind a result's right-click menu and its configurable corner buttons (`floatingResultActions`,
// `compactResultActions`), from RightClickMenu.swift and ActionButtons.swift. One table per file kind: the menu is built from it,
// the buttons pick entries from it, and the main process validates every action id and argument the renderer sends against it.
// Nothing here touches Node or Electron, so the renderer builds the same menus for the browser preview.

/** The built-in action names a button can hold (`FloatingAction`), plus `pipeline:image=<id>;video=<id>`. */
export type ButtonName = 'downscale' | 'compression' | 'crop' | 'share' | 'restoreOptimise' | 'aggressiveOptimisation' | 'copyToClipboard' | 'showInFinder' | 'quickLook' | 'saveAs' | 'addToShelf' | 'sendSecurely' | 'targetSize';
/** Windows has no shelf apps or secure send, so those two buttons are hidden. */
export const UNAVAILABLE_BUTTONS: readonly string[] = ['addToShelf', 'sendSecurely'];
export const MAX_FLOATING_BUTTONS = 5, MAX_COMPACT_BUTTONS = 9;

export const ACTIONS = [
  'stop', 'dismiss', 'restore', 'reoptimise', 'preview', 'compare', 'saveAs', 'copy', 'reveal', 'openDefault', 'copyPath', 'openWith', 'editWith', 'share', 'crop', 'pipeline',
  'stripExif', 'fitUnder', 'downscale', 'resolution', 'aggressive', 'compression', 'convert', 'removeAudio', 'hdrToSdr', 'speed', 'toGif', 'encoder',
  'bitrate', 'normalise', 'coverArt', 'coverDownscale', 'pagesToImages', 'menu',
] as const;
export type ActionId = (typeof ACTIONS)[number];
/** What a menu entry or button asks for: an action, and the one argument it takes. */
export interface Invocation { action: ActionId; arg?: string | number }
export type MenuNode =
  | { separator: true }
  | { header: string }
  | { label: string; invoke?: Invocation; submenu?: MenuNode[]; enabled?: boolean; checked?: boolean; hint?: string };

/** What a card is, as far as its menu cares. A result (`ItemResult`) satisfies it. */
export interface CardItem {
  kind: MediaKind; status: 'processing' | 'ready' | 'error'; format: string; animated: boolean; name?: string;
  restored?: boolean; unchanged?: boolean; pages?: number; outputBytes?: number;
  options: { mode: 'balanced' | 'aggressive' | 'lossless'; scale: number; speed?: number; format: string; compression?: { tier: string; factor: number } };
}
/** What a menu needs to know beyond the card, which only the main process can look up. */
export interface Facts {
  native: boolean;
  /** The name of the app `editorAppImage`/`Video`/`PDF`/`Audio` points at, when set. */
  editor?: string;
  /** Saved pipelines the card can run. */
  pipelines?: { id: string; name: string; text?: string }[];
  /** Video: has an audio track, is HDR. */
  hasAudio?: boolean; hdr?: boolean;
  /** Audio: the format's allowed bitrates (kbps) and whether the file has cover art. */
  bitrates?: readonly number[]; hasCoverArt?: boolean;
}

export const DOWNSCALE_FACTORS = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1] as const;
export const COMPRESSION_FACTORS = [10, 20, 30, 40, 50, 60, 70, 80, 90] as const;
export const SPEED_UP = [1.25, 1.5, 1.75, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const, SLOW_DOWN = [0.25, 0.5, 0.75] as const;
export const GIF_WIDTHS = [1920, 1280, 800, 640, 480, 320] as const, GIF_FPS = [24, 20, 15, 10] as const;
export const LOUDNESS_TARGETS: readonly { name: string; lufs: number }[] = [
  { name: 'Loud (−12 LUFS)', lufs: -12 }, { name: 'Streaming (−14 LUFS)', lufs: -14 }, { name: 'Podcast (−16 LUFS)', lufs: -16 }, { name: 'Speech (−19 LUFS)', lufs: -19 }, { name: 'Broadcast (−23 LUFS)', lufs: -23 },
];
export const TARGET_SIZES: readonly { label: string; bytes: number }[] = [
  { label: '500 KB', bytes: 500_000 }, { label: '1 MB', bytes: 1_000_000 }, { label: '2 MB', bytes: 2_000_000 }, { label: '5 MB', bytes: 5_000_000 },
  { label: '8 MB (Discord)', bytes: 8_000_000 }, { label: '10 MB', bytes: 10_000_000 }, { label: '25 MB', bytes: 25_000_000 }, { label: '50 MB', bytes: 50_000_000 },
];
/** Every bitrate (kbps) an audio format's menu offers (`allowedBitrates` in core/media/audioFormat.ts); the format's own list is checked in the main process. */
export const AUDIO_BITRATES = [32, 48, 56, 64, 80, 96, 128, 160, 192, 256, 320] as const;
export const PDF_RESOLUTIONS = [300, 250, 200, 150, 100, 72, 48] as const;
export const VIDEO_ENCODERS: readonly { id: string; name: string }[] = [
  { id: 'fast', name: 'Fast, battery efficient, larger file' }, { id: 'slowHighQuality', name: 'Slow, high quality, smaller file' }, { id: 'visuallyLossless', name: 'Visually lossless' },
];
/** What the Convert submenu offers per kind (`ItemType.convertibleTypes`, plus the Windows extras). */
export const CONVERSIONS: Record<Exclude<MediaKind, 'pdf'>, readonly { to: string; name: string }[]> = {
  image: [{ to: 'jpeg', name: 'JPEG' }, { to: 'webp', name: 'WebP' }, { to: 'avif', name: 'AVIF' }, { to: 'heic', name: 'HEIC' }, { to: 'png', name: 'PNG' }, { to: 'jxl', name: 'JPEG XL' }, { to: 'gif', name: 'GIF' }],
  video: [{ to: 'mp4', name: 'MP4' }, { to: 'mov', name: 'MOV' }, { to: 'hevc', name: 'MP4 (HEVC)' }, { to: 'av1', name: 'MKV (AV1)' }, { to: 'webm', name: 'WebM' }],
  audio: [{ to: 'm4a', name: 'M4A (AAC)' }, { to: 'mp3', name: 'MP3' }, { to: 'ogg', name: 'Ogg (Opus)' }, { to: 'wav', name: 'WAV' }, { to: 'flac', name: 'FLAC' }],
};

const ALL: readonly MediaKind[] = ['image', 'video', 'pdf', 'audio'];
/** The kinds each action applies to. */
export const ACTION_KINDS: Record<ActionId, readonly MediaKind[]> = {
  stop: ALL, dismiss: ALL, restore: ALL, reoptimise: ALL, preview: ALL, compare: ALL, saveAs: ALL, copy: ALL, reveal: ALL, openDefault: ALL, copyPath: ALL, openWith: ALL, editWith: ALL, share: ALL, pipeline: ALL, fitUnder: ALL, menu: ALL,
  crop: ['image', 'video', 'pdf'], stripExif: ['image', 'video'], downscale: ['image', 'video'], resolution: ['pdf'], aggressive: ['image', 'pdf', 'audio'], compression: ['image', 'video'], convert: ['image', 'video', 'audio'],
  removeAudio: ['video'], hdrToSdr: ['video'], speed: ['video', 'audio'], toGif: ['video'], encoder: ['video'], bitrate: ['audio'], normalise: ['audio'], coverArt: ['audio'], coverDownscale: ['audio'], pagesToImages: ['pdf'],
};

const numberIn = (list: readonly number[], arg: unknown) => typeof arg === 'number' && list.includes(arg);
const GIF = /^(\d+)x(\d+)$/;
/** Whether `arg` is one the action takes. Anything else from the renderer is refused. */
function validArg(kind: MediaKind, action: ActionId, arg: unknown): boolean {
  switch (action) {
    case 'pipeline': return typeof arg === 'string' && arg.length > 0 && arg.length <= 200;
    case 'fitUnder': return typeof arg === 'number' && TARGET_SIZES.some(size => size.bytes === arg);
    case 'downscale': return numberIn([1, ...DOWNSCALE_FACTORS], arg);
    case 'resolution': return numberIn(PDF_RESOLUTIONS, arg);
    case 'compression': return arg === 'lossless' || (arg === 'adaptive' && kind === 'image') || numberIn(COMPRESSION_FACTORS, arg);
    case 'convert': return typeof arg === 'string' && kind !== 'pdf' && CONVERSIONS[kind].some(c => c.to === arg);
    case 'speed': return numberIn([1, ...SPEED_UP, ...SLOW_DOWN], arg);
    case 'toGif': { const m = typeof arg === 'string' ? GIF.exec(arg) : null; return !!m && numberIn(GIF_WIDTHS, +m[1]) && numberIn(GIF_FPS, +m[2]); }
    case 'encoder': return typeof arg === 'string' && VIDEO_ENCODERS.some(e => e.id === arg);
    case 'bitrate': return numberIn(AUDIO_BITRATES, arg);
    case 'normalise': return typeof arg === 'number' && LOUDNESS_TARGETS.some(t => t.lufs === arg);
    case 'coverDownscale': return numberIn([1, ...DOWNSCALE_FACTORS], arg);
    case 'pagesToImages': return arg === 'jpeg' || arg === 'png';
    case 'menu': return typeof arg === 'string' && (MENUS as readonly string[]).includes(arg);
    // The compare window's file actions (`fileActions` in CompareView.swift) work on either side: the result, or with `original` the original it is compared with.
    case 'reveal': case 'openDefault': case 'copyPath': return arg === undefined || arg === 'original';
    default: return arg === undefined;
  }
}
/** The keys that do a menu entry's action on the card under the pointer, as the menu's hints say. */
export const SHORTCUTS: Readonly<Record<string, Invocation>> = {
  Delete: { action: 'dismiss' }, ' ': { action: 'preview' }, d: { action: 'compare' }, k: { action: 'crop' }, s: { action: 'saveAs' }, c: { action: 'copy' }, r: { action: 'restore' }, a: { action: 'aggressive' },
};
/** The submenus a corner button opens by name. */
export const MENUS = ['downscale', 'compression', 'targetSize', 'convert', 'pipelines', 'speed', 'resolution', 'bitrate', 'coverDownscale', 'gif', 'encoder', 'normalise', 'pages'] as const;

/** Checks a renderer's request against the table: a known action for this kind, with an argument it takes. */
export function parseInvocation(kind: MediaKind, value: unknown): Invocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose an action.');
  const { action, arg } = value as { action?: unknown; arg?: unknown };
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) throw new Error('Choose an action.');
  const id = action as ActionId;
  if (!ACTION_KINDS[id].includes(kind)) throw new Error(`This action does not work on ${kind === 'pdf' ? 'PDFs' : `${kind}s`}.`);
  if (!validArg(kind, id, arg)) throw new Error('This action does not take that value.');
  return arg === undefined ? { action: id } : { action: id, arg: arg as string | number };
}

/**
 * Why an invocation must not run on this file even though the table accepts it, or undefined: the menu disables or hides these entries
 * (`facts` is what the main process learned from the file), so a request for one is refused the same way.
 */
export function refuseUnavailable(item: Pick<CardItem, 'kind'>, { action, arg }: Invocation, facts: Facts): string | undefined {
  if (action === 'removeAudio' && facts.hasAudio === false) return 'This video has no audio to remove.';
  if (action === 'hdrToSdr' && !facts.hdr) return 'This video is not HDR.';
  if ((action === 'coverArt' || action === 'coverDownscale') && facts.hasCoverArt === false) return 'This file has no cover art.';
  if (action === 'bitrate' && item.kind === 'audio' && !facts.bitrates?.includes(arg as number)) return 'This format has no such bitrate.';
  return undefined;
}

/** What running an invocation does. `steps` run through the pipeline executor on the card's current file, `apply` re-optimises an image from its original, `edit` is a direct media operation (core/cards/edits.ts), `ui` is the app's part. */
export type Plan =
  | { type: 'apply'; options: Record<string, unknown>; label: string }
  | { type: 'steps'; steps: PipelineStep[]; label: string }
  | { type: 'edit'; edit: 'hdrToSdr' | 'toGif' | 'coverArt' | 'coverDownscale'; arg?: string | number; label: string }
  | { type: 'ui'; ui: UiAction; arg?: string | number };
/** The actions the app itself carries out: windows, dialogs, the clipboard, launching apps, saved pipelines, and a menu a button opens. */
export type UiAction = 'stop' | 'dismiss' | 'restore' | 'preview' | 'compare' | 'saveAs' | 'copy' | 'reveal' | 'openDefault' | 'copyPath' | 'openWith' | 'editWith' | 'share' | 'crop' | 'pipeline' | 'pagesToImages' | 'menu';

const step = makeStep;
/** The change an invocation makes to a card, or the app-side action it names. */
export function planFor(item: Pick<CardItem, 'kind' | 'options'>, { action, arg }: Invocation): Plan {
  const kind = item.kind;
  switch (action) {
    case 'reoptimise': return kind === 'image' ? { type: 'apply', options: {}, label: 'Optimising' } : { type: 'steps', steps: [step('optimise', {})], label: 'Optimising' };
    case 'stripExif': return { type: 'steps', steps: [step('stripExif', {})], label: 'Stripping metadata' };
    case 'fitUnder': return { type: 'steps', steps: [step('targetSize', { bytes: arg as number })], label: 'Fitting under size' };
    case 'aggressive':
      return kind === 'image' ? { type: 'apply', options: { mode: 'aggressive', compression: undefined }, label: 'Optimising' }
        : { type: 'steps', steps: [step('optimise', { encoder: 'aggressive' })], label: 'Optimising' };
    case 'compression':
      if (kind === 'image') return { type: 'apply', options: arg === 'lossless' ? { mode: 'lossless', compression: undefined } : { compression: { tier: arg === 'adaptive' ? 'adaptive' : 'custom', factor: arg === 'adaptive' ? 5 : arg } }, label: 'Compressing' };
      return { type: 'steps', steps: [step('optimise', { encoder: 'medium', compression: arg === 'lossless' ? { tier: 'lossless', factor: 5 } : { tier: 'smaller', factor: arg as number } })], label: 'Compressing' };
    case 'downscale':
      if (kind === 'image') return { type: 'apply', options: { scale: arg, maxEdge: undefined, crop: undefined }, label: 'Resizing' };
      return { type: 'steps', steps: [step('downscale', { factor: arg as number })], label: 'Downscaling' };
    case 'resolution': return { type: 'steps', steps: [step('optimise', { encoder: 'medium', dpi: arg as number })], label: 'Lowering resolution' };
    case 'convert':
      if (kind === 'image') return { type: 'apply', options: { format: arg === 'jpg' ? 'jpeg' : arg }, label: 'Converting' };
      return { type: 'steps', steps: [step('convert', { to: arg as string, location: 'inPlace' })], label: 'Converting' };
    case 'removeAudio': return { type: 'steps', steps: [step('removeAudio', {})], label: 'Removing audio' };
    case 'speed': return { type: 'steps', steps: [step('changeSpeed', { factor: arg as number })], label: 'Changing speed' };
    case 'encoder': return { type: 'steps', steps: [step('optimise', { encoder: 'medium', videoEncoder: arg as never })], label: 'Re-encoding' };
    case 'bitrate': return { type: 'steps', steps: [step('lowerBitrate', { kbps: arg as number })], label: 'Lowering bitrate' };
    case 'normalise': return { type: 'steps', steps: [step('normalize', { lufs: arg as number })], label: 'Normalising loudness' };
    case 'hdrToSdr': return { type: 'edit', edit: 'hdrToSdr', label: 'Converting HDR to SDR' };
    case 'toGif': return { type: 'edit', edit: 'toGif', arg, label: 'Converting to GIF' };
    case 'coverArt': return { type: 'edit', edit: 'coverArt', label: 'Extracting cover art' };
    case 'coverDownscale': return { type: 'edit', edit: 'coverDownscale', arg, label: 'Downscaling cover art' };
    case 'pagesToImages': default: return { type: 'ui', ui: action, arg };
  }
}

const label = (text: string, invoke?: Invocation, extra: Partial<Extract<MenuNode, { label: string }>> = {}): MenuNode => ({ label: text, ...(invoke ? { invoke } : {}), ...extra });
const sep: MenuNode = { separator: true };

/**
 * The menu of one side's file in the compare window, behind its path field and its right-click (`fileActions` in CompareView.swift):
 * open it, show it in Explorer, copy its path. `original` is the original the result is compared with, otherwise the result.
 */
export function fileActions(side: 'original' | 'result'): MenuNode[] {
  const arg = side === 'original' ? { arg: 'original' } : {};
  return [label('Open', { action: 'openDefault', ...arg }), label('Show in Explorer', { action: 'reveal', ...arg }), label('Copy Path', { action: 'copyPath', ...arg })];
}
const percent = (factor: number) => `${Math.round(factor * 100)}%`;
const speedName = (factor: number) => `${factor < 2 ? factor.toFixed(2) : factor}x`;

function downscaleMenu(item: CardItem, title = 'Downscale resolution to', restore = 'Restore original size (100%)'): MenuNode[] {
  const current = item.options.scale;
  return [label(restore, { action: 'downscale', arg: 1 }, { enabled: current !== 1 }), { header: title }, ...DOWNSCALE_FACTORS.map(f => label(percent(f), { action: 'downscale', arg: f }, { checked: f === current }))];
}
function compressionMenu(item: CardItem): MenuNode[] {
  const current = item.options.compression;
  if (item.kind === 'image') return [
    label('Adaptive (best size and quality)', { action: 'compression', arg: 'adaptive' }, { checked: current?.tier === 'adaptive' }),
    label('Lossless', { action: 'compression', arg: 'lossless' }, { checked: item.options.mode === 'lossless' }),
    { header: 'Compression factor' }, ...COMPRESSION_FACTORS.map(f => label(`${f}%`, { action: 'compression', arg: f }, { checked: current?.tier === 'custom' && current.factor === f })),
  ];
  return [label('Lossless', { action: 'compression', arg: 'lossless' }), { header: 'Compression factor' }, ...COMPRESSION_FACTORS.map(f => label(`${f}%`, { action: 'compression', arg: f }))];
}
const targetSizeMenu = (item: CardItem): MenuNode[] => TARGET_SIZES.map(size => label(size.label, { action: 'fitUnder', arg: size.bytes }, { enabled: !(item.outputBytes && item.outputBytes <= size.bytes) }));
const speedMenu = (item: CardItem): MenuNode[] => {
  const current = item.options.speed ?? 1, entry = (f: number) => label(speedName(f), { action: 'speed', arg: f }, { checked: f === current });
  return [label('Restore normal playback speed (1x)', { action: 'speed', arg: 1 }, { enabled: current !== 1 }), { header: 'Playback speed up' }, ...SPEED_UP.map(entry), { header: 'Playback slow down' }, ...SLOW_DOWN.map(entry)];
};
const gifMenu = (): MenuNode[] => GIF_FPS.flatMap(fps => [{ header: `${fps}fps` } as MenuNode, ...GIF_WIDTHS.map(w => label(`${w}px max width @ ${fps}fps${fps === 20 && w === 800 ? ' (recommended)' : ''}`, { action: 'toGif', arg: `${w}x${fps}` }))]);
const convertMenu = (item: CardItem): MenuNode[] => item.kind === 'pdf' ? [] : CONVERSIONS[item.kind].map(c => label(c.name, { action: 'convert', arg: c.to }, { checked: c.to === item.format || (c.to === 'jpeg' && item.format === 'jpg') }));
const pipelinesMenu = (facts: Facts): MenuNode[] => facts.pipelines?.length ? facts.pipelines.map(p => label(p.name, { action: 'pipeline', arg: p.id }, p.text ? { hint: p.text } : {})) : [label('No saved pipelines', undefined, { enabled: false }), label('Save a pipeline in Settings, Pipelines', undefined, { enabled: false })];
const bitrateMenu = (facts: Facts): MenuNode[] => (facts.bitrates ?? []).map(k => label(`${k} kbps`, { action: 'bitrate', arg: k }));
const pagesMenu = (): MenuNode[] => [{ header: 'Best for photos and illustrations' }, label('JPEG', { action: 'pagesToImages', arg: 'jpeg' }), { header: 'Best for text and low-detail images' }, label('PNG', { action: 'pagesToImages', arg: 'png' })];
const normaliseMenu = (): MenuNode[] => LOUDNESS_TARGETS.map(t => label(t.name, { action: 'normalise', arg: t.lufs }));
const encoderMenu = (): MenuNode[] => VIDEO_ENCODERS.map(e => label(e.name, { action: 'encoder', arg: e.id }));
const resolutionMenu = (): MenuNode[] => PDF_RESOLUTIONS.map(dpi => label(`${dpi} DPI${dpi === 300 ? ' (no downsampling)' : ''}`, { action: 'resolution', arg: dpi }));
const coverMenu = (item: CardItem) => downscaleMenu(item, 'Downscale cover art to').map(node => 'invoke' in node && node.invoke?.action === 'downscale' ? { ...node, invoke: { action: 'coverDownscale' as const, arg: node.invoke.arg } } : node);

/** The submenu a corner button opens: the same entries the right-click menu has under that name. */
export function submenu(name: string, item: CardItem, facts: Facts): MenuNode[] {
  switch (name) {
    case 'downscale': return downscaleMenu(item);
    case 'compression': return compressionMenu(item);
    case 'targetSize': return targetSizeMenu(item);
    case 'convert': return convertMenu(item);
    case 'pipelines': return pipelinesMenu(facts);
    case 'speed': return speedMenu(item);
    case 'resolution': return resolutionMenu();
    case 'bitrate': return bitrateMenu(facts);
    case 'coverDownscale': return coverMenu(item);
    case 'gif': return gifMenu();
    case 'encoder': return encoderMenu();
    case 'normalise': return normaliseMenu();
    case 'pages': return pagesMenu();
    default: return [];
  }
}

const sub = (text: string, name: string, item: CardItem, facts: Facts, extra: Partial<Extract<MenuNode, { label: string }>> = {}): MenuNode => label(text, undefined, { submenu: submenu(name, item, facts), ...extra });

/** Whether the card's file can be reduced by a compression factor: an image or a video. */
export const canCompress = (kind: MediaKind) => kind === 'image' || kind === 'video';
/** The crop window works on every image, video and PDF; macOS limits it to png, jpeg, gif, mp4, mov and PDF. */
export const cropAllowed = (kind: MediaKind) => kind !== 'audio';

/** The right-click menu of one result (`RightClickMenuView`). */
export function itemMenu(item: CardItem, facts: Facts): MenuNode[] {
  const { kind } = item, busy = item.status === 'processing', ready = item.status === 'ready';
  const nodes: MenuNode[] = [
    busy ? label('Stop', { action: 'stop' }) : label('Dismiss', { action: 'dismiss' }, { hint: 'Delete' }),
    label(kind === 'video' ? 'Restore original video' : 'Restore original', { action: 'restore' }, { enabled: !busy && !item.restored, hint: 'R' }),
    sep, label('Preview', { action: 'preview' }, { enabled: ready, hint: 'Space' }), label(kind === 'audio' ? 'Compare (A/B)' : 'Compare (diff)', { action: 'compare' }, { enabled: ready, hint: 'D' }),
  ];
  if (!ready) return nodes;
  nodes.push(sep, { header: 'File' }, label('Save as…', { action: 'saveAs' }, { hint: 'S' }), label('Copy to clipboard', { action: 'copy' }, { hint: 'C' }), label('Show in Explorer', { action: 'reveal' }, { enabled: facts.native }));
  if (facts.native) nodes.push(sep, { header: 'Open' }, label('Open with default app', { action: 'openDefault' }),
    ...(facts.editor ? [label(`Edit with ${facts.editor}`, { action: 'editWith' })] : []), label('Open with…', { action: 'openWith' }));
  const transform: MenuNode[] = [];
  if (cropAllowed(kind)) transform.push(label('Crop and resize…', { action: 'crop' }, { hint: 'K' }));
  if (kind === 'video') transform.push(label('Remove audio', { action: 'removeAudio' }, { enabled: facts.hasAudio !== false }));
  if (kind === 'audio') transform.push(label('Extract cover art', { action: 'coverArt' }, { enabled: facts.hasCoverArt !== false }));
  if (kind !== 'video') transform.push(label('Aggressive optimisation', { action: 'aggressive' }, { enabled: !(kind === 'image' && item.options.mode === 'aggressive'), hint: 'A' }));
  if (kind === 'video' && facts.hdr) transform.push(label('Convert HDR to SDR', { action: 'hdrToSdr' }));
  if (kind === 'audio') { if (facts.bitrates?.length) transform.push(sub('Change bitrate', 'bitrate', item, facts)); }
  else if (kind === 'pdf') transform.push(sub('Reduce image resolution', 'resolution', item, facts));
  else transform.push(sub('Downscale', 'downscale', item, facts));
  if (canCompress(kind)) transform.push(sub('Compression', 'compression', item, facts));
  if (kind === 'audio') transform.push(sub('Normalise loudness', 'normalise', item, facts), sub('Downscale cover art', 'coverDownscale', item, facts, { enabled: facts.hasCoverArt !== false }));
  if (kind === 'video' || kind === 'audio') transform.push(sub('Change playback speed', 'speed', item, facts));
  if (kind === 'video') transform.push(sub('Convert to GIF', 'gif', item, facts), sub('Re-optimise with encoder', 'encoder', item, facts));
  if (kind === 'pdf' && item.pages) transform.push(sub(item.pages === 1 ? 'Convert to image' : 'Extract pages as images', 'pages', item, facts));
  if (kind !== 'pdf' && !(item.animated && kind === 'image')) transform.push(sub('Convert to…', 'convert', item, facts));
  nodes.push(sep, { header: 'Transform' }, ...transform);
  nodes.push(sep, { header: 'Share' }, label(facts.native ? 'Share (copy file and show in Explorer)' : 'Share', { action: 'share' }, { enabled: facts.native }));
  const advanced: MenuNode[] = [];
  if (kind === 'image' || kind === 'video') advanced.push(label('Strip EXIF metadata', { action: 'stripExif' }));
  advanced.push(sub('Fit under size', 'targetSize', item, facts), sub('Pass file through pipeline', 'pipelines', item, facts, { enabled: facts.native }));
  nodes.push(sep, { header: 'Advanced' }, ...advanced);
  return nodes;
}

/** The actions the batch menu applies to a selection, each to the results it works on. */
export const BATCH_ACTIONS: readonly ActionId[] = ['saveAs', 'copy', 'restore', 'stripExif', 'dismiss', 'downscale', 'speed', 'aggressive', 'bitrate', 'hdrToSdr'];
/**
 * The menu over a selection of results (`BatchRightClickMenuView`): what works on several at once. `facts` is for the first video (HDR) and
 * the first audio file (its format's bitrates), as macOS looks at the first one too. Saving and copying work on the finished results, so they wait for one. macOS also offers QuickLook, sending and shelf apps,
 * which have no counterpart here (Preview opens one window per result and is left out).
 */
export function batchMenu(items: CardItem[], facts: Facts = { native: true }): MenuNode[] {
  const of = (...kinds: MediaKind[]) => items.filter(item => kinds.includes(item.kind));
  const sized = of('image', 'video'), nodes: MenuNode[] = [
    label('Save all to folder…', { action: 'saveAs' }, { enabled: items.some(item => item.status === 'ready') }), label('Copy to clipboard', { action: 'copy' }, { enabled: items.some(item => item.status === 'ready') }), sep,
    label('Restore all', { action: 'restore' }, { enabled: items.some(item => !item.restored) }), sep,
  ];
  if (sized.length) nodes.push(sub('Downscale', 'downscale', sized[0], facts, { enabled: sized.some(item => item.kind !== 'image' || item.options.scale > 0.1) }));
  if (of('audio').length && facts.bitrates?.length) nodes.push(sub('Change bitrate', 'bitrate', of('audio')[0], facts));
  if (of('video', 'audio').length) nodes.push(sub('Change playback speed', 'speed', of('video', 'audio')[0], facts));
  if (of('image', 'pdf', 'audio').length) nodes.push(label('Aggressive optimisation', { action: 'aggressive' }, { enabled: of('image', 'pdf', 'audio').some(item => !(item.kind === 'image' && item.options.mode === 'aggressive')) }));
  if (of('video').length && facts.hdr) nodes.push(label('Convert HDR to SDR', { action: 'hdrToSdr' }));
  if (sized.length) nodes.push(sep, label('Strip EXIF metadata', { action: 'stripExif' }));
  nodes.push(sep, label('Dismiss', { action: 'dismiss' }));
  return nodes;
}

// Corner buttons.
export interface ButtonDef { name: string; label: string; icon: string; invoke?: Invocation; menu?: string; panel?: 'scale' | 'compression' }
const LOSSLESS_AUDIO = ['wav', 'flac', 'aiff', 'aif'];
const BUTTONS: Record<string, { label: string; icon: string }> = {
  downscale: { label: 'Downscale', icon: 'minus' }, compression: { label: 'Compression', icon: 'settings' }, crop: { label: 'Crop and resize', icon: 'crop' }, share: { label: 'Share', icon: 'share' },
  restoreOptimise: { label: 'Restore / Optimise', icon: 'restore' }, aggressiveOptimisation: { label: 'Aggressive optimisation', icon: 'bolt' }, copyToClipboard: { label: 'Copy to clipboard', icon: 'copy' },
  showInFinder: { label: 'Show in Explorer', icon: 'folder' }, quickLook: { label: 'Preview', icon: 'eye' }, saveAs: { label: 'Save as…', icon: 'down' }, targetSize: { label: 'Fit under size', icon: 'target' },
};
export const BUTTON_NAMES = Object.keys(BUTTONS);
/** `pipeline:image=<id>;video=<id>` → the id for a kind (its own, else `any`), or undefined. */
export function pipelineButtonId(name: string, kind: MediaKind): string | undefined {
  if (!name.startsWith('pipeline:')) return undefined;
  const ids = new Map<string, string>();
  for (const pair of name.slice(9).split(';')) { const [key, ...rest] = pair.split('='); if (rest.length && ['image', 'video', 'audio', 'pdf', 'any'].includes(key) && rest.join('=')) ids.set(key, rest.join('=')); }
  if (!name.includes('=')) return name.slice(9) || undefined;
  return ids.get(kind) ?? ids.get('any');
}
/**
 * The corner buttons a card shows for `names` (`floatingResultActions` or `compactResultActions`): those that apply to its kind
 * and exist on Windows, at most `max`. A downscale button on audio is "Downscale cover art" and on a PDF the resolution menu, as on macOS.
 */
export function buttonsFor(item: CardItem, names: readonly string[], facts: Facts, max: number, panels = true): ButtonDef[] {
  const out: ButtonDef[] = [], kind = item.kind;
  for (const name of names) {
    if (out.length >= max) break;
    const pipeline = pipelineButtonId(name, kind);
    if (name.startsWith('pipeline:')) {
      const saved = pipeline && facts.pipelines?.find(p => p.id === pipeline);
      if (saved) out.push({ name, label: saved.name, icon: 'wand', invoke: { action: 'pipeline', arg: saved.id } });
      continue;
    }
    if (UNAVAILABLE_BUTTONS.includes(name) || !(name in BUTTONS)) continue;
    const base = BUTTONS[name];
    switch (name) {
      case 'downscale':
        if (kind === 'image') out.push({ name, ...base, ...(panels ? { panel: 'scale' as const } : { menu: 'downscale' }) });
        else if (kind === 'audio') { if (facts.hasCoverArt !== false) out.push({ name, ...base, label: 'Downscale cover art', menu: 'coverDownscale' }); }
        else if (kind === 'pdf') out.push({ name, ...base, label: 'Compression', menu: 'resolution' });
        else out.push({ name, ...base, menu: 'downscale' });
        break;
      case 'compression':
        if (kind === 'image') out.push({ name, ...base, ...(panels ? { panel: 'compression' as const } : { menu: 'compression' }) });
        else if (kind === 'video') out.push({ name, ...base, menu: 'compression' });
        else if (kind === 'audio' && (facts.bitrates ? facts.bitrates.length > 0 : !LOSSLESS_AUDIO.includes(item.format))) out.push({ name, ...base, label: 'Change bitrate', menu: 'bitrate' });
        break;
      case 'crop': if (cropAllowed(kind)) out.push({ name, ...base, invoke: { action: 'crop' } }); break;
      case 'share': out.push({ name, ...base, invoke: { action: 'share' } }); break;
      case 'restoreOptimise': out.push({ name, ...base, label: item.restored ? 'Optimise' : 'Restore original', icon: item.restored ? 'bolt' : 'restore', invoke: { action: item.restored ? 'reoptimise' : 'restore' } }); break;
      case 'aggressiveOptimisation': if (kind !== 'video') out.push({ name, ...base, invoke: { action: 'aggressive' } }); break;
      case 'copyToClipboard': out.push({ name, ...base, invoke: { action: 'copy' } }); break;
      case 'showInFinder': if (facts.native) out.push({ name, ...base, invoke: { action: 'reveal' } }); break;
      case 'quickLook': out.push({ name, ...base, invoke: { action: 'preview' } }); break;
      case 'saveAs': out.push({ name, ...base, invoke: { action: 'saveAs' } }); break;
      case 'targetSize': out.push({ name, ...base, menu: 'targetSize' }); break;
    }
  }
  return out;
}
