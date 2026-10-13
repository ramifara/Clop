import path from 'node:path';
import { downscaleAudioCoverArt, extractAudioCoverArt } from '../media/audio';
import { convertVideoToGIF, optimiseVideo } from '../media/video';
import type { MediaJobOptions, MediaOutput } from '../media/types';
import type { ClopSettings } from '../settings/schema';
import type { Plan } from './actions';

// The card actions that are one media operation rather than pipeline steps (the right-click menu's "Convert HDR to SDR", "Convert
// to GIF", "Extract cover art" and "Downscale cover art"). Each calls the same core function the pipeline steps and the CLI use.

export type EditSettings = Pick<ClopSettings, 'videoCompression' | 'videoEncoder' | 'capVideoFPS' | 'targetVideoFPS' | 'minVideoFPS' | 'removeAudioFromVideos' | 'convertAudioToAAC' | 'adaptiveVideoSize' | 'stripMetadata' | 'playbackSpeedFrameBehaviour'>;
export interface EditContext extends Pick<MediaJobOptions, 'signal' | 'onProgress'> {
  /** The card's current file, and a folder for the result. */
  input: string; dir: string; name: string;
  /** The card's original file, which cover art is scaled from so repeated downscales do not compound. */
  original?: string;
  settings: EditSettings;
}
/** Edits whose result is a new card (the cover picture) rather than a change to the one they ran on. */
export const NEW_CARD_EDITS: readonly string[] = ['coverArt'];

export function runEdit(edit: Extract<Plan, { type: 'edit' }>['edit'], arg: string | number | undefined, { input, dir, name, original, settings: s, signal, onProgress }: EditContext): Promise<MediaOutput> {
  switch (edit) {
    case 'hdrToSdr':
      return optimiseVideo(input, dir, { compression: s.videoCompression, encoder: s.videoEncoder, capVideoFPS: s.capVideoFPS, targetVideoFPS: s.targetVideoFPS, minVideoFPS: s.minVideoFPS, removeAudio: s.removeAudioFromVideos,
        convertAudioToAAC: s.convertAudioToAAC, adaptiveVideoSize: s.adaptiveVideoSize, stripMetadata: s.stripMetadata, playbackSpeedFrameBehaviour: s.playbackSpeedFrameBehaviour, hdrToSdr: true, allowLarger: true, name, signal, onProgress });
    case 'toGif': {
      const [, width, fps] = /^(\d+)x(\d+)$/.exec(String(arg)) ?? [];
      if (!width) throw new Error('Choose a GIF size.');
      return convertVideoToGIF(input, dir, { maxWidth: +width, fps: +fps, name, signal, onProgress });
    }
    case 'coverArt': return extractAudioCoverArt(input, dir, { signal, onProgress });
    case 'coverDownscale': return scaleCover(input, dir, Number(arg), { original, name, signal, onProgress });
  }
}

/** The audio is copied from the current file and the picture scaled from the original's, so repeated downscales start from the full-size art. */
async function scaleCover(input: string, dir: string, factor: number, { original, name, signal, onProgress }: Pick<EditContext, 'original' | 'name' | 'signal' | 'onProgress'>) {
  const full = original && original !== input ? await extractAudioCoverArt(original, path.join(dir, 'cover-source'), { signal }).then(output => output.path, () => undefined) : undefined;
  return downscaleAudioCoverArt(input, dir, factor, { ...(full ? { original: full } : {}), name, signal, onProgress });
}
