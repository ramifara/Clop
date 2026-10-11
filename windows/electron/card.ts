import type { OptimisationRequest } from '../core/ipc/protocol';
import type { MediaKind } from '../core/media/types';
import type { ImageOptions } from '../src/types';
import type { ItemEngine } from './items';

/**
 * The CLI's "optimise this file and show a card" through the app's item engine (one adapter, so the engine can change behind
 * it). A card for every kind, but only for requests the engine's plain optimisation expresses (aggressive, and a downscale
 * for images); a crop, speed, bitrate, DPI or compression override the pipe service runs itself, without a card. The result is
 * what the pipe service's own run would make: the card's image format setting does not apply, and a factor of 1 or more changes nothing.
 */
export function cardOptimiser(host: { engine: () => ItemEngine; makeRoom(): Promise<void>; defaults(aggressive: boolean): ImageOptions }) {
  return async (file: string, kind: MediaKind, req: OptimisationRequest, signal: AbortSignal): Promise<string | undefined> => {
    const downscaled = req.downscaleFactor !== undefined && (kind === 'image' ? req.downscaleFactor < 0.1 : req.downscaleFactor < 1);
    const changesMore = req.size || req.compression || req.adaptiveOptimisation || req.removeAudio || req.audioBitrate !== undefined || req.pdfDPI !== undefined
      || (req.changePlaybackSpeedFactor !== undefined && req.changePlaybackSpeedFactor !== 1);
    if (downscaled || changesMore) return undefined;
    await host.makeRoom();
    const scale = kind === 'image' && req.downscaleFactor && req.downscaleFactor < 1 ? { scale: req.downscaleFactor } : {};
    const engine = host.engine();
    const id = await engine.importPath(file, 'file', { ...host.defaults(req.aggressiveOptimisation), format: 'auto', ...scale }, undefined, { signal });
    const { result } = engine.get(id);
    if (result.status !== 'ready') throw new Error(result.error ?? `Clop could not optimise this ${kind}.`);
    return result.unchanged ? file : engine.output(id);
  };
}
