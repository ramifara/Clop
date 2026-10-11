import type { OptimisationRequest } from '../core/ipc/protocol';
import type { MediaKind } from '../core/media/types';
import type { FileBehaviour } from '../core/placement';
import type { ImageOptions } from '../src/types';
import type { ItemEngine, ItemPlacement } from './items';

/**
 * Whether a request's card places its result itself. Not with an explicit output, and not when the result of an optimisation or of
 * an automatic conversion would stay in the shelf (`temporary`): the pipe service copies that beside the file, where the card would
 * answer with a path in the session folder, which goes away at the next start.
 */
export const cardPlaces = (req: Pick<OptimisationRequest, 'output'>, behaviour: (kind: 'optimised' | 'autoConvert') => FileBehaviour) =>
  !req.output && behaviour('optimised') !== 'temporary' && behaviour('autoConvert') !== 'temporary';

/**
 * The CLI's "optimise this file and show a card" through the app's item engine (one adapter, so the engine can change behind
 * it). A card for every kind, but only for requests the engine's plain optimisation expresses (aggressive, and a downscale
 * for images); a crop, speed, bitrate, DPI or compression override the pipe service runs itself, without a card. The result is
 * what the pipe service's own run would make: the card's image format setting does not apply, and a factor of 1 or more changes nothing.
 * With a `placement` for the request, the card places its result itself and answers `{ placed }`; the service then places nothing.
 */
export function cardOptimiser(host: { engine: () => ItemEngine; makeRoom(): Promise<void>; defaults(aggressive: boolean): ImageOptions; placement?(file: string, kind: MediaKind, req: OptimisationRequest): ItemPlacement | undefined }) {
  return async (file: string, kind: MediaKind, req: OptimisationRequest, signal: AbortSignal): Promise<string | { placed: string } | undefined> => {
    const downscaled = req.downscaleFactor !== undefined && (kind === 'image' ? req.downscaleFactor < 0.1 : req.downscaleFactor < 1);
    const changesMore = req.size || req.compression || req.adaptiveOptimisation || req.removeAudio || req.audioBitrate !== undefined || req.pdfDPI !== undefined
      || (req.changePlaybackSpeedFactor !== undefined && req.changePlaybackSpeedFactor !== 1);
    if (downscaled || changesMore) return undefined;
    await host.makeRoom();
    const scale = kind === 'image' && req.downscaleFactor && req.downscaleFactor < 1 ? { scale: req.downscaleFactor } : {};
    const engine = host.engine();
    // The card places its result over the file itself, as a watched file's card does, so its Restore and "Revert last optimisations" undo the write.
    const placement = host.placement?.(file, kind, req);
    const id = await engine.importPath(file, 'file', { ...host.defaults(req.aggressiveOptimisation), format: 'auto', ...scale }, undefined, { signal, ...(placement ? { placement } : {}) });
    const { result } = engine.get(id);
    if (result.status !== 'ready') throw new Error(result.error ?? `Clop could not optimise this ${kind}.`);
    if (placement) return { placed: engine.output(id) };
    return result.unchanged ? file : engine.output(id);
  };
}
