import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Window frames kept across launches, as AppKit keeps a window's frame under its autosave name (`setFrameAutosaveName` and
// `setFrameUsingName` in CropWindow.swift: every crop window shares the "Crop Window" frame). A frame is in Electron's
// device-independent pixels, the unit of `getBounds` and `workArea`.

export interface Rect { x: number; y: number; width: number; height: number }
/** How much of a remembered frame must still be on a display to put the window there again; less, and it opens centred. */
const VISIBLE = 80;

const isRect = (value: unknown): value is Rect => {
  const r = value as Partial<Rect> | null;
  return typeof r === 'object' && r !== null && [r.x, r.y, r.width, r.height].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e6);
};
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Where a window opens from its remembered frame, like `setFrameUsingName`: on the display it overlaps most, made no larger than that
 * display's work area and no smaller than `min`, and moved inside it. Undefined (open centred, the default) when nothing is remembered,
 * the record is damaged, or too little of it is on any display now (a display that was unplugged).
 */
export function restoredFrame(saved: unknown, areas: readonly Rect[], min: { width: number; height: number }): Rect | undefined {
  if (!isRect(saved) || saved.width <= 0 || saved.height <= 0) return undefined;
  let best: Rect | undefined, most = 0;
  for (const area of areas) { const shared = overlap(saved, area); if (shared > most) { most = shared; best = area; } }
  if (!best || most < VISIBLE * VISIBLE) return undefined;
  const width = Math.round(Math.min(Math.max(saved.width, min.width), best.width)), height = Math.round(Math.min(Math.max(saved.height, min.height), best.height));
  const x = Math.round(Math.min(Math.max(saved.x, best.x), best.x + best.width - width)), y = Math.round(Math.min(Math.max(saved.y, best.y), best.y + best.height - height));
  return { x, y, width, height };
}

/** Frames by name, in a small JSON file of the app's own (not the settings, which macOS shares). A missing or damaged file remembers nothing. */
export class WindowFrames {
  private frames: Record<string, Rect> = {};
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  constructor(readonly file: string, private readonly delayMs = 400) {}
  async load() {
    let stored: unknown;
    try { stored = JSON.parse(await readFile(this.file, 'utf8')); } catch {}
    this.frames = {};
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) for (const [name, rect] of Object.entries(stored)) if (isRect(rect)) this.frames[name] = rect;
    return this;
  }
  get(name: string): Rect | undefined { return this.frames[name]; }
  /** Keeps `rect` as `name`'s frame. Moving and resizing save once they settle; `now` (a closing window) saves at once. */
  remember(name: string, rect: Rect, { now = false } = {}) {
    if (!isRect(rect)) return Promise.resolve();
    this.frames[name] = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    clearTimeout(this.timer);
    if (now) return this.save();
    this.timer = setTimeout(() => { void this.save(); }, this.delayMs);
    this.timer.unref?.();
    return Promise.resolve();
  }
  /** Writes the frames through a temporary file, one write after another. */
  save() {
    clearTimeout(this.timer); this.timer = undefined;
    const text = JSON.stringify(this.frames), temporary = `${this.file}.${process.pid}.tmp`;
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(temporary, text);
      await rename(temporary, this.file);
    }).catch(error => console.warn(`Could not save the window frames: ${error instanceof Error ? error.message : error}`));
    return this.writing;
  }
}

/** The part of an Electron window that frames are read from. */
export interface FramedWindow { getNormalBounds(): Rect; isMinimized(): boolean; on(event: 'move' | 'resize' | 'close', listener: () => void): unknown }
/** Remembers `window`'s frame as `name` whenever it moves or is resized, and at once when it closes. A minimised window keeps the frame it had. */
export function trackFrame(frames: WindowFrames, name: string, window: FramedWindow) {
  const keep = (now: boolean) => { if (!window.isMinimized()) void frames.remember(name, window.getNormalBounds(), { now }); };
  window.on('move', () => keep(false));
  window.on('resize', () => keep(false));
  window.on('close', () => keep(true));
}
