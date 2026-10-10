import { run } from '../run';

export interface ClipOptions {
  width?: number; height?: number; seconds?: number; fps?: number;
  /** Audio codec for a 440 Hz tone, or false for no audio track. */
  audio?: string | false;
  /** Video encoder arguments; near-lossless H.264 by default, so optimising has something to save. */
  video?: string[];
  metadata?: Record<string, string>;
}

/** Writes a short test clip: ffmpeg's testsrc2 pattern with a sine tone. */
export async function clip(file: string, { width = 320, height = 240, seconds = 0.5, fps = 30, audio = 'aac', video = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p'], metadata = {} }: ClipOptions = {}) {
  const sources = ['-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=${fps}:d=${seconds}`, ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:d=${seconds}`] : [])];
  const tags = Object.entries(metadata).flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);
  await run('ffmpeg', ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', ...sources, ...video, ...(audio ? ['-c:a', audio] : []), ...tags, '-shortest', file]);
  return file;
}

/** A 10-bit HEVC clip tagged as HDR10 (PQ transfer, BT.2020 primaries), like a phone's HDR recording. */
export const hdrClip = (file: string, options: ClipOptions = {}) => clip(file, {
  ...options, video: ['-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1'],
});
