import type { ClopSettings } from '../core/settings/schema';

export type FloatingTiming = Pick<ClopSettings, 'autoHideFloatingResults' | 'autoHideFloatingResultsAfter' | 'autoHideClipboardResultAfter'>;

/**
 * Milliseconds before a result hides, or undefined when it stays (`hideClipboardAfter` and `hideFilesAfter` in OptimisationUtils.swift).
 * A clipboard result takes `autoHideClipboardResultAfter`, with -1 meaning the file delay; 0 means never.
 */
export function hideDelay(settings: FloatingTiming, source: string) {
  if (!settings.autoHideFloatingResults) return;
  const seconds = source === 'clipboard' && settings.autoHideClipboardResultAfter !== -1 ? settings.autoHideClipboardResultAfter : settings.autoHideFloatingResultsAfter;
  return seconds > 0 ? seconds * 1000 : undefined;
}

/** How often the follower looks at the cursor, and how many looks in a row on another display move the results there (`cursorScreenFollowerTick`: about 1.5 s). */
export const FOLLOW_INTERVAL_MS = 500, FOLLOW_TICKS = 3;

/**
 * Decides when the floating results move to the display the cursor is on: only after the cursor stayed on the same other
 * display for `FOLLOW_TICKS` looks, so crossing a monitor on the way elsewhere does not drag them along.
 */
export class CursorFollower {
  private pending?: number;
  private ticks = 0;
  /**
   * One look. `cursor` and `current` are display ids; `active` says whether results are on screen, `frozen` whether a drag or
   * held button is going on (the dwell count then stands still instead of starting over). Returns the display to move to.
   */
  tick({ cursor, current, active, frozen = false }: { cursor: number; current: number | undefined; active: boolean; frozen?: boolean }) {
    if (frozen) return;
    if (!active || cursor === current) { this.reset(); return; }
    if (cursor !== this.pending) { this.pending = cursor; this.ticks = 1; return; }
    if (++this.ticks < FOLLOW_TICKS) return;
    this.reset();
    return cursor;
  }
  reset() { this.pending = undefined; this.ticks = 0; }
}
