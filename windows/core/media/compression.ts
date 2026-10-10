import type { CompressionQuality } from '../settings/schema';

// The CompressionQuality translations from Shared.swift. The factor runs 5 (best quality) to 100 (smallest file).
export const COMPRESSION_FACTOR_NORMAL = 30, COMPRESSION_FACTOR_AGGRESSIVE = 64;

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
// Swift's rounded() and Math.round differ only on negative halves, which these curves never produce.
const round = Math.round;

/** `effectiveImageCompression` (Images.swift): an explicit aggressive flag picks the normal or aggressive anchor, otherwise the configured setting applies. */
export function effectiveImageCompression(aggressive: boolean | undefined, configured: CompressionQuality): CompressionQuality {
  if (aggressive === undefined) return configured;
  return { tier: 'custom', factor: aggressive ? COMPRESSION_FACTOR_AGGRESSIVE : COMPRESSION_FACTOR_NORMAL };
}

export const imageIsAggressive = ({ tier, factor }: CompressionQuality) => tier !== 'adaptive' && factor >= 50;

/** jpegoptim --max. Factor 30 gives 85. */
export const jpegMaxQuality = ({ factor }: CompressionQuality) => factor <= 70
  ? clamp(round(85 - (factor - 30) * (55 / 70)), 25, 95)
  : clamp(round(54 - (factor - 70) * (36 / 30)), 18, 95);

/** jpegoptim --max for the adaptive PNG-to-JPEG test. Factor 30 gives 90. */
export const jpegSecondaryMaxQuality = ({ factor }: CompressionQuality) => factor <= 70
  ? clamp(round(90 - (factor - 30) * (60 / 70)), 25, 97)
  : clamp(round(56 - (factor - 70) * (36 / 30)), 20, 97);

/** pngquant --quality. Factor 30 gives 0-100. */
export const pngQuantQuality = ({ factor }: CompressionQuality) => `0-${clamp(round(100 - (factor - 30) * (75 / 70)), 25, 100)}`;

/** pngquant's palette size, from factor 80 up; otherwise its default of 256. */
export const pngQuantColors = ({ factor }: CompressionQuality) => factor >= 80 ? clamp(224 - (factor - 80) * 8, 64, 256) : undefined;

export const pngQuantSpeed = ({ factor }: CompressionQuality) => factor < 40 ? 4 : factor < 60 ? 3 : factor < 85 ? 2 : 1;

/** Factor 30 gives -O2 --lossy=30; 64 gives -O3 --lossy=80 --colors=202. */
export function gifsicleArgs({ factor }: CompressionQuality) {
  const level = factor >= 50 ? 3 : factor >= 20 ? 2 : 1;
  const lossy = factor <= 70 ? clamp(round(30 + (factor - 30) * (50 / 34)), 0, 200) : round(89 * Math.pow(2000 / 89, (factor - 70) / 30));
  const args = [`-O${level}`, `--lossy=${lossy}`];
  if (factor >= 50) args.push(`--colors=${clamp(round(256 - (factor - 50) * (192 / 50)), 32, 256)}`);
  return args;
}

/** Drop every Nth frame of an animated GIF from factor 80: every 4th, 3rd from 90, 2nd from 98. */
export const gifFrameDropEveryNth = ({ factor }: CompressionQuality) => factor < 80 ? undefined : factor < 90 ? 4 : factor < 98 ? 3 : 2;

/** cwebp, heif-enc and ffmpeg libwebp_anim -q. Factor 30 gives 60. */
export const conversionQuality = ({ factor }: CompressionQuality) => factor <= 70
  ? clamp(round(75 - factor * 0.5), 20, 90)
  : clamp(round(40 - (factor - 70) * (25 / 30)), 15, 90);

/** cjxl -q, JXLCoder's quality. Factor 30 gives 60; the cap is 95 rather than 90. */
export const jxlQuality = ({ factor }: CompressionQuality) => factor <= 70
  ? clamp(round(75 - factor * 0.5), 20, 95)
  : clamp(round(40 - (factor - 70) * (25 / 30)), 15, 95);

/** cjxl -e, JXLCoder's effort: 7 below factor 50, 8 from 50, 9 from 70. */
export const jxlEffort = ({ factor }: CompressionQuality) => factor >= 70 ? 9 : factor >= 50 ? 8 : 7;
