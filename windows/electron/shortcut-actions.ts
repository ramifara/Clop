import { ACTION_KINDS, type ActionId } from '../core/cards/actions';
import { nextDownscale, nextPause, nextResolution, nextSpeed, type ShortcutAction } from '../core/shortcuts';
import type { ItemResult } from '../src/types';

// What each global shortcut does (`handleHotkey` in ClopApp.swift), written against a small host so which result a key acts on is tested
// without Electron. Shortcuts act on the newest result in view and never silently on an older one: while it is still working they say so.

export interface ShortcutHost {
  /** The results in view, newest first. */
  items(): ItemResult[];
  /** The newest clipboard result, in view or not. */
  latestClipboard(): ItemResult | undefined;
  /** Runs a card action on a result, as its menu would. */
  run(id: string, invocation: { action: ActionId; arg?: string | number }): Promise<void>;
  open(view: 'preview' | 'crop', id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
  stop(ids: string[]): void;
  bringBack(): void;
  paused(): boolean;
  setPaused(paused: boolean): Promise<unknown>;
  optimiseClipboard(aggressive: boolean): Promise<void>;
  /** Optimises what is on the clipboard and resolves with the new result, once it is ready. */
  freshClipboard(): Promise<ItemResult | undefined>;
  /** The bitrates (kbps) an audio result's format allows. */
  bitrates(id: string): Promise<readonly number[]>;
  inform(text: string): void;
}

const NO_RESULT = 'There is no result to do this on. Copy or drop a file first.';

export class ShortcutRunner {
  /** How far shortcuts and card actions have stepped a result: `down:<id>` the downscale factor of a video, `dpi:<id>` a PDF's resolution, `speed:<id>` the playback speed, `bitrate:<id>` an audio file's. */
  private steps = new Map<string, number>();
  private pauseNext = false;
  constructor(private host: ShortcutHost) {}

  /** A card action that worked, from a shortcut or the card's menu: the next step goes on from there, and a restore starts over. */
  noted(id: string, { action, arg }: { action: ActionId; arg?: string | number }) {
    const stepped = ({ downscale: 'down', resolution: 'dpi', speed: 'speed', bitrate: 'bitrate' } as Partial<Record<ActionId, string>>)[action];
    if (stepped && typeof arg === 'number') this.steps.set(`${stepped}:${id}`, arg);
    else if (action === 'restore') this.forget(id);
  }
  forget(id: string) { for (const kind of ['down', 'dpi', 'speed', 'bitrate']) this.steps.delete(`${kind}:${id}`); }
  /** Whether the next clipboard event is to be ignored ("pause for the next clipboard event"); asking uses it up. */
  /** The pause setting changed, by the key or from the tray, Settings, the CLI or the file: an armed "pause for the next clipboard event" no longer applies. */
  pauseChanged() { this.pauseNext = false; }
  consumePauseNext() { const was = this.pauseNext; this.pauseNext = false; return was; }

  /** The newest result in view, ready; `undefined` when there is none. A result still working or failed is said so and never skipped for an older one. */
  private target(): ItemResult | undefined {
    const item = this.host.items()[0];
    if (!item) return undefined;
    if (item.status === 'processing') throw new Error('Wait for this result to finish first.');
    if (item.status === 'error') throw new Error(`The newest result failed (${item.error ?? 'unknown error'}). Dismiss it first.`);
    return item;
  }
  private needTarget() { const item = this.target(); if (!item) throw new Error(NO_RESULT); return item; }

  async run({ kind, factor }: ShortcutAction): Promise<void> {
    const { host } = this;
    switch (kind) {
      case 'optimiseClipboard': return host.optimiseClipboard(false);
      case 'aggressive': {
        const item = this.target();
        if (!item) return host.optimiseClipboard(true);
        if (item.options.mode === 'aggressive') return;
        if (!ACTION_KINDS.aggressive.includes(item.kind)) throw new Error(`Aggressive optimisation is not offered for ${item.kind === 'video' ? 'videos' : item.kind}.`);
        return host.run(item.id, { action: 'aggressive' });
      }
      case 'downscale': case 'resize': {
        const item = this.target();
        if (item) return this.downscale(item, factor);
        const fresh = await host.freshClipboard();
        if (fresh) await this.downscale(fresh, factor);
        return;
      }
      case 'speedUp': {
        const item = this.target() ?? await host.freshClipboard();
        if (item) return this.speedUp(item);
        return;
      }
      case 'dismiss': { const newest = host.items()[0]; if (newest) await host.dismiss(newest.id); return; }
      // The results in view only: work on files in watched folders that nothing shows carries on.
      case 'clearAll': { const ids = host.items().map(item => item.id); host.stop(ids); for (const id of ids) await host.dismiss(id); return; }
      case 'bringBack': return host.bringBack();
      case 'preview': {
        const item = this.target() ?? host.latestClipboard() ?? await host.freshClipboard();
        if (item) await host.open('preview', item.id);
        return;
      }
      case 'crop': return host.open('crop', this.needTarget().id);
      case 'restore': { const item = this.needTarget(); if (item.restored || item.unchanged) return; return host.run(item.id, { action: 'restore' }); }
      case 'pause': {
        const next = nextPause({ paused: host.paused(), pauseNext: this.pauseNext });
        this.pauseNext = next.pauseNext;
        if (next.paused !== host.paused()) await host.setPaused(next.paused);
        host.inform(next.notice);
        return;
      }
    }
  }

  /** "Downscale and preview the clipboard": the clipboard's result goes one step down (or to `factor`), and shows in the preview window when asked. */
  async downscaleClipboard(factor?: number, preview = false) {
    const fresh = await this.host.freshClipboard();
    if (!fresh) return;
    await this.downscale(fresh, factor);
    if (preview) await this.host.open('preview', fresh.id);
  }

  private async downscale(item: ItemResult, factor?: number) {
    const { host } = this;
    if (item.kind === 'audio') {
      if (factor !== undefined) throw new Error('Audio has no resolution. Press the downscale key to lower its bitrate.');
      // The file's own bitrate is not known here: the first step goes down from the highest the format allows.
      const allowed = [...await host.bitrates(item.id)].sort((a, b) => b - a), current = this.steps.get(`bitrate:${item.id}`) ?? allowed[0], next = allowed.find(kbps => kbps < current);
      if (!next) throw new Error('This audio file is already at its lowest bitrate.');
      return this.step(item.id, { action: 'bitrate', arg: next });
    }
    if (item.kind === 'pdf') {
      if (factor !== undefined) throw new Error('PDFs are downscaled by resolution: press the downscale key.');
      const dpi = nextResolution(this.steps.get(`dpi:${item.id}`));
      if (!dpi) throw new Error('This PDF is already at the lowest resolution.');
      return this.step(item.id, { action: 'resolution', arg: dpi });
    }
    const current = item.kind === 'image' ? item.options.scale : this.steps.get(`down:${item.id}`) ?? 1, target = factor ?? nextDownscale(current);
    if (!target) throw new Error('This result is already at the smallest size.');
    return this.step(item.id, { action: 'downscale', arg: target });
  }
  private async speedUp(item: ItemResult) {
    if (item.kind !== 'video' && item.kind !== 'audio') throw new Error('Only videos and audio can play faster.');
    const speed = nextSpeed(this.steps.get(`speed:${item.id}`) ?? 1);
    if (!speed) throw new Error('This result is already at the fastest speed.');
    return this.step(item.id, { action: 'speed', arg: speed });
  }
  private async step(id: string, invocation: { action: ActionId; arg: number }) { await this.host.run(id, invocation); this.noted(id, invocation); }
}
