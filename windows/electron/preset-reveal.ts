/** How long Ctrl may be down and still count as a tap (`MODIFIER_TAP_MAX_DURATION` in OptimisationUtils.swift). */
export const TAP_MAX_MS = 400;

/**
 * Whether the preset zones show in the drop zone during a drag, from the keys the Windows helper reports (`handlePresetZonesModifier`
 * in OptimisationUtils.swift). Ctrl stands in for the Mac's Control: by default holding it shows them and a tap pins them until the
 * next tap; with `onlyShowPresetZonesOnControlTapped` only a tap shows or hides them. A tap is Ctrl pressed alone and released within
 * `TAP_MAX_MS`; Alt (the drop zone's key) or Shift (aggressive optimisation) down with it spoils the tap. The helper does not report
 * keystrokes or clicks, which cancel a tap on macOS.
 */
export class PresetReveal {
  private down = false;
  private downAt = 0;
  private alone = true;
  private pinned = false;

  /** `other` is Alt or Shift being down. */
  update(keys: { ctrl: boolean; other: boolean }, tapOnly: boolean, now = Date.now()) {
    if (keys.ctrl && !this.down) { this.downAt = now; this.alone = !keys.other; }
    if (keys.ctrl && keys.other) this.alone = false;
    if (!keys.ctrl && this.down) {
      const tap = this.alone && now - this.downAt <= TAP_MAX_MS;
      this.pinned = tap ? !this.pinned : tapOnly ? this.pinned : false;
    }
    this.down = keys.ctrl;
  }

  revealed(tapOnly: boolean) { return this.pinned || (!tapOnly && this.down); }

  reset() { this.down = false; this.alone = true; this.pinned = false; }
}
