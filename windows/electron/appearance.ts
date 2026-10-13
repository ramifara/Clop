// Light and dark windows, and the acrylic glass behind the drop zone. No `electron` import: the windows are passed in, so this runs under plain Node in tests.

/** What a window shows before its page paints, so a dark window does not flash white (the `--bg` of theme.css). */
export const windowBackground = (dark: boolean) => dark ? '#1f1c21' : '#f3f1ef';

/**
 * Whether Windows draws the acrylic material behind a window: Windows 11 22H2 (build 22621) and later, the versions Electron's
 * `backgroundMaterial` supports. `release` is `os.release()`, such as `10.0.22631`. Windows 10 gets the tinted drop zone instead.
 */
export function acrylicSupported(platform: string, release: string) {
  return platform === 'win32' && Number(release.split('.')[2]) >= 22621;
}

export interface Rect { x: number; y: number; width: number; height: number }
/** The drop zone's box in the floating window's page, and the size of the page it was measured in. */
export interface DropZoneBox extends Rect { pageWidth: number; pageHeight: number }
/** The drop zone's box from the floating window's renderer: whole pixels within reason, or undefined for none. */
export function parseDropRect(value: unknown): DropZoneBox | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') throw new Error('Send the drop zone as a box.');
  const { x, y, width, height, pageWidth, pageHeight } = value as Record<string, unknown>, sizes = [x, y, width, height, pageWidth, pageHeight];
  if (!sizes.every(size => typeof size === 'number' && Number.isFinite(size) && size >= 0 && size <= 10_000)) throw new Error('Send the drop zone as a box.');
  const [left, top, w, h, pw, ph] = (sizes as number[]).map(Math.round);
  return w && h ? { x: left, y: top, width: w, height: h, pageWidth: pw, pageHeight: ph } : undefined;
}

/** The parts of a BrowserWindow the backdrop uses. */
export interface BackdropWindow {
  isDestroyed(): boolean; isVisible(): boolean; setBounds(bounds: Rect): void; showInactive(): void; hide(): void; destroy(): void;
  setAlwaysOnTop(flag: boolean): void; setBackgroundMaterial(material: 'acrylic'): void; setContentProtection(enable: boolean): void;
}
export interface FloatingWindow { isDestroyed(): boolean; isVisible(): boolean; getBounds(): Rect; isAlwaysOnTop(): boolean; moveTop(): void }

/**
 * The acrylic behind the drop zone. The floating window is transparent, and Windows draws a backdrop material over a whole window
 * only, so a small frameless acrylic window sits exactly under the drop zone and below the floating window; the floating window
 * keeps drawing the zone, its tint and its text, and keeps taking the drop, so the result cards work as before. The backdrop is
 * made the first time the zone shows and follows it: `place` with the zone's box (or undefined) and again when the floating window moves.
 */
export class DropBackdrop {
  private zone?: DropZoneBox;
  private window?: BackdropWindow;
  private hiddenFromCapture = false;
  constructor(private readonly floating: FloatingWindow, private readonly create: () => BackdropWindow) {}
  place(zone: DropZoneBox | undefined) { this.zone = zone; this.sync(); }
  /** Lines the backdrop up with the floating window's zone, shows it under the floating window, or hides it. */
  sync() {
    const { floating } = this, zone = this.zone;
    const open = this.window && !this.window.isDestroyed() ? this.window : undefined;
    if (!zone || floating.isDestroyed() || !floating.isVisible()) { if (open?.isVisible()) open.hide(); return; }
    const at = floating.getBounds();
    // While the floating window resizes, the box measured in the old page would put the glass in the wrong place: the renderer measures again.
    if (Math.abs(at.width - zone.pageWidth) > 2 || Math.abs(at.height - zone.pageHeight) > 2) return;
    const window = open ?? (this.window = this.made());
    window.setBounds({ x: at.x + zone.x, y: at.y + zone.y, width: zone.width, height: zone.height });
    window.setAlwaysOnTop(floating.isAlwaysOnTop());
    if (window.isVisible()) return;
    window.showInactive();
    // Set again once shown: Windows applies the material to a window it is drawing.
    window.setBackgroundMaterial('acrylic');
    floating.moveTop();
  }
  /** Hidden from screenshots with the floating window (`allowClopToAppearInScreenshots`). */
  protect(hidden: boolean) { this.hiddenFromCapture = hidden; if (this.window && !this.window.isDestroyed()) this.window.setContentProtection(hidden); }
  destroy() { if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.window = undefined; }
  private made() { const window = this.create(); window.setContentProtection(this.hiddenFromCapture); return window; }
}
