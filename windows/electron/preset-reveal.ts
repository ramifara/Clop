/** How long Ctrl or Alt may be down and still count as a tap (`MODIFIER_TAP_MAX_DURATION` in OptimisationUtils.swift). */
export const TAP_MAX_MS = 400;

/**
 * Whether the preset zones are showing in the drop zone during a drag, from the Ctrl and Alt state the Windows helper reports
 * (`handlePresetZonesModifier` in OptimisationUtils.swift). By default holding the key shows them and a tap pins them open until the
 * next tap; with `onlyShowPresetZonesOnControlTapped` only a tap shows or hides them. A tap is one key pressed alone and released
 * within `TAP_MAX_MS`. The helper does not report keystrokes or clicks, which cancel a tap on macOS.
 */
export class PresetReveal {
  private down = 0;
  private downAt = 0;
  private alone = true;
  private pinned = false;

  update(keys: { ctrl: boolean; alt: boolean }, tapOnly: boolean, now = Date.now()) {
    const count = Number(keys.ctrl) + Number(keys.alt);
    if (count > 0 && this.down === 0) { this.downAt = now; this.alone = true; }
    if (count > 1) this.alone = false;
    if (count === 0 && this.down > 0) {
      const tap = this.alone && now - this.downAt <= TAP_MAX_MS;
      this.pinned = tap ? !this.pinned : tapOnly ? this.pinned : false;
    }
    this.down = count;
  }

  revealed(tapOnly: boolean) { return this.pinned || (!tapOnly && this.down > 0); }

  reset() { this.down = 0; this.alone = true; this.pinned = false; }
}
