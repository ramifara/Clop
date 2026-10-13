// The floating results' layout (OptimisationUtils.swift `compactResults`, FloatingResult.swift): the compact list takes over when
// `alwaysShowCompactResults` is on or more results are visible than fit, stays until every result is gone, and clears all its
// results `autoClearAllCompactResultsAfter` seconds after the last one finished.

export interface CompactRow { id: string; running: boolean }
export interface Timers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
const real: Timers = { set: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; }, clear: handle => clearTimeout(handle as NodeJS.Timeout) };

/** How many full-size cards fit in a work area `height` pixels high (at most 5, as on macOS), with a drop target taking room. */
export function cardsThatFit(height: number, dropTarget = false, cardHeight = 170, reserved = 60) {
  return Math.max(1, Math.min(5, Math.floor((height - reserved - (dropTarget ? 160 : 0)) / cardHeight)));
}

export interface CompactOptions {
  always: () => boolean;
  /** 0 never clears. */
  seconds: () => number;
  fit: () => number;
  /** Hides the results, the way an expired card hides. */
  clear: (ids: string[]) => void;
  /** A result is hovered or a selection is under way: clearing waits. */
  paused?: () => boolean;
  /** The layout changed. */
  switched?: (compact: boolean) => void;
  timers?: Timers;
}
export class CompactMode {
  compact = false;
  private rows: CompactRow[] = [];
  private timer: unknown;
  private armed = '';
  constructor(private options: CompactOptions) {}
  private get timers() { return this.options.timers ?? real; }
  /** Takes the visible results (newest first or last, it does not matter) and returns whether the compact list shows. */
  update(rows: readonly CompactRow[]): boolean {
    this.rows = [...rows];
    const was = this.compact;
    this.compact = this.options.always() || rows.length > this.options.fit() || (was && rows.length > 0);
    if (this.compact !== was) this.options.switched?.(this.compact);
    this.arm();
    return this.compact;
  }
  private arm() {
    const seconds = this.options.seconds(), settled = this.compact && seconds > 0 && this.rows.length > 0 && this.rows.every(row => !row.running);
    // A change to the results starts the countdown again; an unchanged set keeps the one under way.
    const key = settled ? `${seconds}|${this.rows.map(row => row.id).sort().join(',')}` : '';
    if (key === this.armed) return;
    this.cancel();
    if (!key) return;
    this.armed = key;
    this.timer = this.timers.set(() => this.expire(), seconds * 1000);
  }
  private expire() {
    this.timer = undefined;
    if (this.options.paused?.()) { this.timer = this.timers.set(() => this.expire(), 1000); return; }
    const ids = this.rows.map(row => row.id);
    this.armed = '';
    if (ids.length) this.options.clear(ids);
  }
  private cancel() { if (this.timer !== undefined) this.timers.clear(this.timer); this.timer = undefined; this.armed = ''; }
  dispose() { this.cancel(); }
}
