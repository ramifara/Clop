export type ClipboardChange = { sequence: number; paths: string[]; image?: boolean; process?: number; app?: string };
// Editors known to rewrite the clipboard after every stroke while they are in front.
const autoCopyEditors = new Set(['snippingtool', 'screenclippinghost', 'screensketch']);
type Timers = { set: (callback: () => void, delay: number) => unknown; clear: (timer: unknown) => void; now: () => number };
const systemTimers: Timers = { set: (callback, delay) => setTimeout(callback, delay), clear: timer => clearTimeout(timer as NodeJS.Timeout), now: () => Date.now() };

// Decides when a clipboard change is worth optimising. Quick successive writes settle into one
// pickup. An app that keeps writing images while it stays in front is treated as an editing
// session: only its latest version is kept, and it is optimised once the user leaves that app.
export class ClipboardPickup {
  private pending?: ClipboardChange & { editing: boolean };
  private timer: unknown;
  private session?: { process: number; at: number };
  constructor(private pick: (change: ClipboardChange) => void, private settle = 300, private sessionGap = 30_000, private timers: Timers = systemTimers) {}
  change(change: ClipboardChange) {
    const now = this.timers.now(), process = change.process || 0;
    let editing = false;
    if (change.image && process) {
      editing = autoCopyEditors.has(change.app ?? '') || (this.session?.process === process && now - this.session.at < this.sessionGap);
      this.session = { process, at: now };
    } else this.session = undefined;
    this.cancel();
    this.pending = { ...change, editing };
    if (!editing) this.timer = this.timers.set(() => this.flush(), this.settle);
  }
  focus(process: number) {
    if (this.session && this.session.process !== process) this.session = undefined;
    if (this.pending?.editing && this.pending.process !== process) this.flush();
  }
  cancel() {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined; this.pending = undefined;
  }
  private flush() {
    const change = this.pending;
    this.cancel();
    if (change) { const { editing, ...rest } = change; this.pick(rest); }
  }
}
