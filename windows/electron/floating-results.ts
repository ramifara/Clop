import type { ClopSettings } from '../core/settings/schema';

export type FloatingTiming = Pick<ClopSettings, 'enableFloatingResults' | 'autoHideFloatingResults' | 'autoHideFloatingResultsAfter' | 'autoHideClipboardResultAfter'>;

/**
 * Milliseconds before a result hides, or undefined when it stays (`hideClipboardAfter` and `hideFilesAfter` in OptimisationUtils.swift).
 * A clipboard result takes `autoHideClipboardResultAfter`, with -1 meaning the file delay; 0 means never. With the results switched
 * off (`enableFloatingResults`) nothing is on screen to hide, so results wait on the shelf with no timer until it is switched on.
 */
export function hideDelay(settings: FloatingTiming, source: string) {
  if (!settings.enableFloatingResults || !settings.autoHideFloatingResults) return;
  const seconds = source === 'clipboard' && settings.autoHideClipboardResultAfter !== -1 ? settings.autoHideClipboardResultAfter : settings.autoHideFloatingResultsAfter;
  return seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * What to do with the hide timers after the timing settings changed. `running` is the delay each timer was started with. A timer that
 * already counts the delay the settings give keeps counting; one whose delay changed starts again from now; one the settings no longer
 * want (auto-hide or the results switched off, or its result no longer shown) stops. A result without a timer that should have one starts.
 */
export function hideChanges(shown: readonly { id: string; source: string }[], running: ReadonlyMap<string, number>, settings: FloatingTiming) {
  const start: string[] = [], stop: string[] = [], ids = new Set(shown.map(item => item.id));
  for (const id of running.keys()) if (!ids.has(id)) stop.push(id);
  for (const { id, source } of shown) {
    const wanted = hideDelay(settings, source), have = running.get(id);
    if (wanted === have) continue;
    if (have !== undefined) stop.push(id);
    if (wanted !== undefined) start.push(id);
  }
  return { start, stop };
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

/**
 * Whether the drop target shows. During a drag with `onlyShowDropZoneOnOption` it shows only while Alt is held (macOS toggles it with an
 * Option tap; the helper reports the held keys, so Windows follows the key); otherwise whenever a drop is expected.
 */
export function dropZoneShown({ expecting, dragging, onlyWithAlt, alt }: { expecting: boolean; dragging: boolean; onlyWithAlt: boolean; alt: boolean }) {
  return expecting && (!dragging || !onlyWithAlt || alt);
}
