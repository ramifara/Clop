import { buttonsFor, MAX_COMPACT_BUTTONS, MAX_FLOATING_BUTTONS, type ButtonDef, type Facts } from '../core/cards/actions';
import type { AppState, ItemResult } from './types';

export const humanSize = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1000))} KB`;
const pad = (value: number) => String(value).padStart(2, '0');
export function duration(ms: number) { const s = Math.round(ms / 1000), h = Math.floor(s / 3600); return h ? `${h}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`; }
export const NOUNS = { image: 'image', video: 'video', pdf: 'PDF', audio: 'audio file' } as const;
/** Runs a request to the main process, shows its failure on the shelf, and refreshes the state; `success` is a short toast. */
export type Run = (task: () => Promise<unknown>, success?: string) => Promise<void>;

/** What the corner buttons need to know about a card beyond the card itself. */
export const factsFor = (state: Pick<AppState, 'native' | 'pipelines'>, item: ItemResult): Facts => ({ native: state.native, pipelines: state.pipelines?.filter(pipeline => !pipeline.fileType || pipeline.fileType === item.kind) });
/** The buttons a card shows: `floatingResultActions` on a full card, `compactResultActions` in the list. A full card has panels of its own for images; the list opens menus instead. */
export const cardButtons = (state: Pick<AppState, 'native' | 'pipelines' | 'settings'>, item: ItemResult, compact: boolean): ButtonDef[] =>
  compact ? buttonsFor(item, state.settings.compactResultActions, factsFor(state, item), MAX_COMPACT_BUTTONS, false) : buttonsFor(item, state.settings.floatingResultActions, factsFor(state, item), MAX_FLOATING_BUTTONS, true);
/** Whether a card has the 'Copied' toast for an action. */
export const toastFor = (action: string) => action === 'copy' ? 'Copied' : undefined;
