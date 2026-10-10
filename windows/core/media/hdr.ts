import sharp from 'sharp';
import path from 'node:path';
import { run } from '../run';

/** The colour description ffprobe reads from an image's nclx box (HEIC, AVIF), cICP chunk (PNG) or JXL header. */
export interface Colour { transfer?: string; primaries?: string }

/** Runs on the bare file name in its folder, like the other tools (see `readableImage`). */
export async function probeColour(file: string, signal?: AbortSignal): Promise<Colour> {
  const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer,color_primaries', '-of', 'json', path.basename(file)];
  const { stdout } = await run('ffprobe', args, { signal, cwd: path.dirname(file) });
  const stream = (JSON.parse(stdout.toString()).streams ?? [])[0] ?? {};
  return { transfer: stream.color_transfer, primaries: stream.color_primaries };
}

/** PQ (HDR10, iPhone and Android HDR photos) or HLG pixels. Gain-map HDR has an SDR base image and needs nothing. */
export const isHDR = ({ transfer }: Colour) => transfer === 'smpte2084' || transfer === 'arib-std-b67';

// BT.2100 constants.
const PQ = { m1: 2610 / 16384, m2: (2523 / 4096) * 128, c1: 3424 / 4096, c2: (2413 / 4096) * 32, c3: (2392 / 4096) * 32 };
const HLG = { a: 0.17883277, b: 1 - 4 * 0.17883277, c: 0.5 - 0.17883277 * Math.log(4 * 0.17883277) };
/** BT.2408 HDR reference white, where SDR white sits. */
const REFERENCE_WHITE = 203;
const HLG_PEAK = 1000;
/** Linear-light conversions to BT.709 primaries. */
const TO_709: Record<string, number[]> = {
  bt2020: [1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187],
  smpte432: [1.2249, -0.2247, 0, -0.042, 1.0419, 0, -0.0197, -0.0786, 1.0979],
};
/** Below this (in units of reference white) pixels pass through; above it highlights roll off toward the content's peak. */
const KNEE = 0.75;

/**
 * Tone-maps PQ or HLG pixels to 8-bit sRGB: linearise, scale so the reference white is SDR white,
 * convert the primaries to BT.709, then roll off highlights above the knee with an extended Reinhard
 * curve on the largest channel (keeps hue) so the content's peak lands on white. Alpha is kept.
 */
export async function toneMapToSDR(input: string, output: string, colour: Colour) {
  const { data, info } = await sharp(input, { ignoreIcc: true }).autoOrient().toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  const samples = new Uint16Array(data.buffer, data.byteOffset, data.length / 2), channels = info.channels, pixels = info.width * info.height;
  const pq = colour.transfer === 'smpte2084', matrix = TO_709[colour.primaries ?? ''];
  const decode = new Float64Array(65536);
  for (let v = 0; v < 65536; v++) decode[v] = pq ? pqToNits(v / 65535) / REFERENCE_WHITE : hlgToScene(v / 65535);
  const linear = new Float32Array(pixels * 3);
  let peak = 1;
  for (let p = 0, i = 0; p < linear.length; p += 3, i += channels) {
    let r = decode[samples[i]], g = decode[samples[i + 1]], b = decode[samples[i + 2]];
    if (!pq) {
      // The HLG OOTF for a 1000-nit display: system gamma 1.2 on BT.2020 luminance.
      const scale = HLG_PEAK * Math.pow(0.2627 * r + 0.678 * g + 0.0593 * b, 0.2) / REFERENCE_WHITE;
      r *= scale; g *= scale; b *= scale;
    }
    if (matrix) [r, g, b] = [matrix[0] * r + matrix[1] * g + matrix[2] * b, matrix[3] * r + matrix[4] * g + matrix[5] * b, matrix[6] * r + matrix[7] * g + matrix[8] * b];
    linear[p] = r; linear[p + 1] = g; linear[p + 2] = b;
    peak = Math.max(peak, r, g, b);
  }
  const out = Buffer.alloc(pixels * channels), span = (peak - KNEE) / (1 - KNEE);
  for (let p = 0, i = 0; p < linear.length; p += 3, i += channels) {
    const r = Math.max(0, linear[p]), g = Math.max(0, linear[p + 1]), b = Math.max(0, linear[p + 2]), max = Math.max(r, g, b);
    const scale = max > KNEE ? rollOff(max, span) / max : 1;
    out[i] = srgb(r * scale); out[i + 1] = srgb(g * scale); out[i + 2] = srgb(b * scale);
    if (channels === 4) out[i + 3] = samples[i + 3] >> 8;
  }
  await sharp(out, { raw: { width: info.width, height: info.height, channels: channels as 3 | 4 } }).png({ compressionLevel: 1 }).toFile(output);
}

function pqToNits(value: number) {
  const p = Math.pow(value, 1 / PQ.m2);
  return 10000 * Math.pow(Math.max(p - PQ.c1, 0) / (PQ.c2 - PQ.c3 * p), 1 / PQ.m1);
}

/** HLG inverse OETF: scene light from 0 to 1. */
const hlgToScene = (value: number) => value <= 0.5 ? (value * value) / 3 : (Math.exp((value - HLG.c) / HLG.a) + HLG.b) / 12;

/** Identity up to the knee, then extended Reinhard on the excess with matching slope, reaching 1 at the content's peak. */
function rollOff(value: number, span: number) {
  const x = (value - KNEE) / (1 - KNEE);
  return KNEE + (1 - KNEE) * (x * (1 + x / (span * span))) / (1 + x);
}

function srgb(value: number) {
  const v = Math.min(1, value);
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
}
