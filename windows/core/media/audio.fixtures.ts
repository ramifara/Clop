import sharp from 'sharp';
import { run } from '../run';

export interface ToneOptions {
  seconds?: number; sampleRate?: number;
  /** Encoder arguments; ffmpeg's default for the extension when omitted. */
  codec?: string[];
  /** Gain in dB, for quiet inputs. */
  volume?: number;
  /** An image to embed as cover art. */
  cover?: string;
}

/** Writes a stereo 440 Hz sine with a little noise, so lossy encoders spend the bitrate they are given. */
export async function tone(file: string, { seconds = 2, sampleRate = 44100, codec = [], volume, cover }: ToneOptions = {}) {
  const sources = ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${sampleRate}:duration=${seconds}`, '-f', 'lavfi', '-i', `anoisesrc=duration=${seconds}:amplitude=0.05:sample_rate=${sampleRate}:seed=1`];
  const mix = `[0][1]amix=inputs=2,aformat=channel_layouts=stereo${volume === undefined ? '' : `,volume=${volume}dB`}[a]`;
  const art = cover ? ['-map', '2:v', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', ...(file.endsWith('.mp3') ? ['-id3v2_version', '3'] : [])] : [];
  await run('ffmpeg', ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', ...sources, ...(cover ? ['-i', cover] : []), '-filter_complex', mix, '-map', '[a]', ...art, ...codec, file]);
  return file;
}

/** Writes cover art: noise looks like a photograph to the entropy test, a flat colour like a graphic. */
export async function coverImage(file: string, width: number, height: number, { photo = true } = {}) {
  const image = sharp({ create: { width, height, channels: 3, background: '#4080c0', ...(photo ? { noise: { type: 'gaussian', mean: 128, sigma: 50 } } : {}) } });
  await (file.endsWith('.png') ? image.png() : image.jpeg({ quality: 95 })).toFile(file);
  return file;
}
