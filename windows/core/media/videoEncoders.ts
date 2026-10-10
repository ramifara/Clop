import { run, ToolError } from '../run';
import { encoderFamily, hardwareArgs, type EncoderChoice, type VideoEncoderSetting, type VideoFamily } from './videoCompression';

/** Hardware encoders in the order `auto` tries them: NVIDIA, Intel, AMD, then Media Foundation's hardware encoders. */
export const HARDWARE_ENCODERS: Record<VideoFamily, readonly string[]> = {
  h264: ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf'],
  hevc: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf'],
};

/** Encoder names from `ffmpeg -encoders`. */
export function parseEncoderList(text: string) {
  return new Set([...text.matchAll(/^\s*[VAS][A-Z.]{5}\s+(\S+)/gm)].map(match => match[1]).filter(name => name !== '='));
}

let listed: Promise<Set<string>> | undefined;
const tested = new Map<string, Promise<boolean>>();

/** The encoders this ffmpeg build has, asked once per process. */
export function ffmpegEncoders() {
  return listed ??= run('ffmpeg', ['-hide_banner', '-encoders'], { timeoutMs: 20_000 }).then(({ stdout }) => parseEncoderList(stdout.toString()))
    .catch(error => { listed = undefined; throw error; });
}

/**
 * Whether an encoder works on this machine: builds list NVENC, Quick Sync and AMF whether or not the
 * GPU and driver exist, so each is tried on one frame, with the arguments a real encode uses. Asked once per process.
 */
export function encoderWorks(encoder: string): Promise<boolean> {
  let result = tested.get(encoder);
  if (!result) {
    const test = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:r=30', '-frames:v', '1', ...hardwareArgs(encoder, { tier: 'fast', factor: 50 }), '-f', 'null', '-'];
    result = ffmpegEncoders().then(names => names.has(encoder) && run('ffmpeg', test, { timeoutMs: 20_000 }).then(() => true, error => { if (error instanceof ToolError) return false; throw error; }));
    tested.set(encoder, result);
    result.catch(() => tested.delete(encoder));
  }
  return result;
}

/** The first hardware encoder of the family that works here, if any. */
export async function hardwareEncoder(family: VideoFamily) {
  for (const encoder of HARDWARE_ENCODERS[family]) if (await encoderWorks(encoder)) return encoder;
}

/**
 * Applies the `videoEncoder` setting. `auto` uses the first working H.264 hardware encoder for the
 * `fast` tier. A named hardware encoder is used when it works, and otherwise its family's software
 * encoder, libx264 or libx265. Naming libx264 or libx265 keeps every tier in software.
 */
export async function chooseEncoder(setting: VideoEncoderSetting = 'auto'): Promise<EncoderChoice> {
  if (setting === 'auto') return { family: 'h264', hardware: await hardwareEncoder('h264') };
  const family = encoderFamily(setting);
  if (setting === 'libx264' || setting === 'libx265') return { family };
  return { family, hardware: await encoderWorks(setting) ? setting : undefined };
}

/** The hardware encoder for an HEVC conversion: the named one, or the first that works for `auto` and H.264 settings. A software setting keeps conversions in software too. */
export async function hevcHardware(setting: VideoEncoderSetting = 'auto') {
  if (setting === 'libx264' || setting === 'libx265') return undefined;
  if (encoderFamily(setting) === 'hevc') return (await chooseEncoder(setting)).hardware;
  return hardwareEncoder('hevc');
}
