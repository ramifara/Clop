import { run } from '../run';

/** The parts of ffprobe's `-show_format -show_streams` JSON that Clop reads. ffprobe writes numbers such as durations and bit rates as strings. */
export interface FFprobeStream {
  index: number; codec_type?: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment'; codec_name?: string; codec_tag_string?: string; profile?: string;
  width?: number; height?: number; pix_fmt?: string; bits_per_raw_sample?: string; r_frame_rate?: string; avg_frame_rate?: string; nb_frames?: string;
  color_range?: string; color_space?: string; color_transfer?: string; color_primaries?: string;
  sample_rate?: string; channels?: number; channel_layout?: string;
  duration?: string; bit_rate?: string;
  disposition?: Record<string, number>; tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}
export interface FFprobeFormat { filename: string; nb_streams: number; format_name: string; format_long_name?: string; duration?: string; size?: string; bit_rate?: string; tags?: Record<string, string> }
export interface FFprobeResult { format: FFprobeFormat; streams: FFprobeStream[] }

/** Runs ffprobe on a file and returns its container and stream descriptions. Rejects when ffprobe cannot read the file. */
export async function ffprobe(file: string, { signal }: { signal?: AbortSignal } = {}): Promise<FFprobeResult> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-hide_banner', '-show_format', '-show_streams', '-of', 'json', file], { signal });
  const parsed = JSON.parse(stdout.toString('utf8')) as Partial<FFprobeResult>;
  if (!parsed.format) throw new Error(`ffprobe could not read ${file}.`);
  return { format: parsed.format, streams: parsed.streams ?? [] };
}

/** A number from one of ffprobe's string fields, or undefined for missing and `N/A` values. */
export function probeNumber(value: string | number | undefined) {
  const number = typeof value === 'number' ? value : value === undefined ? NaN : Number.parseFloat(value);
  return Number.isFinite(number) ? number : undefined;
}

/** A rate such as `30000/1001`, or undefined for `0/0`. */
export function probeRate(value: string | undefined) {
  const [num, den = '1'] = (value ?? '').split('/');
  const rate = Number(num) / Number(den);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}
