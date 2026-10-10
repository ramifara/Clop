import type { CompressionQuality, VIDEO_ENCODERS } from '../settings/schema';

// The video CompressionQuality translations from Shared.swift. The factor runs 5 (best quality) to 100 (smallest file); 0 means auto.
export type VideoEncoderSetting = (typeof VIDEO_ENCODERS)[number];
export type VideoFamily = 'h264' | 'hevc';
/** The legacy macOS `VideoEncoder` presets, which pipelines and imported settings still name. */
export type VideoEncoderPreset = 'fast' | 'slowHighQuality' | 'visuallyLossless';
export type VideoCodecConversion = 'hevc' | 'x265' | 'av1' | 'webm';

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
const round = Math.round;
const at = (factor: number) => Math.max(5, factor) - 5;

/** libx264 CRF. Factor 5 gives 18, 50 about 24, then steeper from 70 (26) to 38 at 100. */
export const videoH264CRF = ({ factor }: CompressionQuality) => factor <= 70 ? clamp(18 + round(at(factor) / 95 * 12), 17, 32) : clamp(26 + round((factor - 70) * (12 / 30)), 17, 38);
/** libx265 CRF. Factor 5 gives 18, 50 about 26, then steeper from 70 (29) to 40 at 100. */
export const videoH265CRF = ({ factor }: CompressionQuality) => factor <= 70 ? clamp(18 + round(at(factor) / 95 * 16), 17, 36) : clamp(29 + round((factor - 70) * (11 / 30)), 17, 40);
/** SVT-AV1 CRF. Factor 5 gives 22, 50 about 35. */
export const videoAV1CRF = ({ factor }: CompressionQuality) => factor <= 70 ? clamp(22 + round(at(factor) / 95 * 28), 20, 55) : clamp(41 + round((factor - 70) * (14 / 30)), 20, 55);
/** libvpx-vp9 CRF. Factor 5 gives 18, 50 about 31. */
export const videoVP9CRF = ({ factor }: CompressionQuality) => factor <= 70 ? clamp(18 + round(at(factor) / 95 * 27), 15, 50) : clamp(36 + round((factor - 70) * (14 / 30)), 15, 50);
/** VideoToolbox H.264 -q:v (higher is better), the `fast` tier on Apple Silicon. Factor 50 gives 49. */
export const videoH264HardwareQuality = ({ factor }: CompressionQuality) => factor <= 70 ? clamp(round(70 - at(factor) / 95 * 45), 25, 75) : clamp(39 - round((factor - 70) * (21 / 30)), 18, 75);
/** VideoToolbox HEVC -q:v (higher is better). Factor 64 gives the legacy fixed 40. */
export const videoHEVCHardwareQuality = ({ factor }: CompressionQuality) => factor <= 70 ? clamp(round(65 - at(factor) / 95 * 40), 20, 70) : clamp(38 - round((factor - 70) * (20 / 30)), 18, 70);
export const videoUsesAutoCRF = ({ factor }: CompressionQuality) => factor <= 0;
/** libx264 and libx265 -preset: slower the more compression is asked for. */
export const videoH264Preset = ({ factor }: CompressionQuality) => factor < 20 ? 'veryfast' : factor < 40 ? 'fast' : factor < 60 ? 'medium' : factor < 85 ? 'slow' : 'slower';

/** `videoEncoderToCQ`: a legacy preset as a compression value. */
export function videoEncoderToCompression(preset: VideoEncoderPreset): CompressionQuality {
  return preset === 'visuallyLossless' ? { tier: 'lossless', factor: 5 } : preset === 'fast' ? { tier: 'fast', factor: 50 } : { tier: 'smaller', factor: 50 };
}

export const encoderFamily = (encoder: VideoEncoderSetting | string): VideoFamily => encoder === 'libx265' || encoder.startsWith('hevc') ? 'hevc' : 'h264';
const tag = (family: VideoFamily) => ['-tag:v', family === 'h264' ? 'avc1' : 'hvc1'];

/**
 * Arguments for a hardware encoder at the compression's quality. NVENC, Quick Sync and AMF take the
 * software CRF as their constant-quality level; Media Foundation's 0–100 quality scale runs the same
 * way as VideoToolbox's -q:v, so it takes the macOS value. Auto (factor 0) leaves the encoder's default.
 * Hardware encoders take 8-bit NV12, or P010 for a 10-bit source going to HEVC.
 */
export function hardwareArgs(encoder: string, compression: CompressionQuality, tenBit = false) {
  const family = encoderFamily(encoder), auto = videoUsesAutoCRF(compression);
  const q = String(family === 'h264' ? videoH264CRF(compression) : videoH265CRF(compression));
  const pixels = ['-pix_fmt', family === 'hevc' && tenBit ? 'p010le' : 'nv12'];
  const vendor = encoder.slice(encoder.indexOf('_') + 1);
  const quality = auto ? [] : vendor === 'nvenc' ? ['-rc', 'vbr', '-cq', q, '-b:v', '0']
    : vendor === 'qsv' ? ['-global_quality', q]
    : vendor === 'amf' ? ['-rc', 'cqp', '-qp_i', q, '-qp_p', q, ...(family === 'h264' ? ['-qp_b', q] : [])]
    : ['-rate_control', 'quality', '-quality', String(family === 'h264' ? videoH264HardwareQuality(compression) : videoHEVCHardwareQuality(compression))];
  // Media Foundation would otherwise fall back to Windows' own software encoder.
  return ['-vcodec', encoder, ...(vendor === 'mf' ? ['-hw_encoding', '1'] : []), ...quality, ...tag(family), ...pixels];
}

function softwareArgs(family: VideoFamily, compression: CompressionQuality, preset: string) {
  const auto = videoUsesAutoCRF(compression);
  if (family === 'h264') return ['-vcodec', 'libx264', ...tag(family), '-preset', preset, ...(auto ? [] : ['-crf', String(videoH264CRF(compression))])];
  return ['-vcodec', 'libx265', ...(auto ? [] : ['-crf', String(videoH265CRF(compression))]), ...tag(family), '-preset', preset];
}

export interface EncoderChoice {
  /** H.264 unless the `videoEncoder` setting names an HEVC encoder. */
  family: VideoFamily;
  /** A hardware encoder that passed its test encode, used by the `fast` tier. */
  hardware?: string;
  /** Whether the source has more than 8 bits per sample. */
  tenBit?: boolean;
}

/**
 * `videoH264Args` (Shared.swift) and the `aggressive` override in `Video.optimise`: `lossless` is CRF
 * 17 (CRF 18 for HEVC), `fast` the hardware encoder or else the software one at its `veryfast` preset,
 * and every other tier the software encoder at the factor's CRF and preset. The tier must already be
 * resolved from `adaptive`.
 */
export function videoEncoderArgs(compression: CompressionQuality, { family, hardware, tenBit }: EncoderChoice, aggressive = false) {
  if (aggressive) return family === 'h264' ? ['-vcodec', 'libx264', ...tag(family), '-preset', 'veryslow', '-crf', '28'] : softwareArgs(family, { tier: 'smaller', factor: 64 }, 'slow');
  if (compression.tier === 'lossless') return family === 'h264' ? ['-vcodec', 'libx264', ...tag(family), '-crf', '17'] : ['-vcodec', 'libx265', '-crf', '18', ...tag(family), '-preset', 'medium'];
  if (compression.tier === 'fast') return hardware ? hardwareArgs(hardware, compression, tenBit) : softwareArgs(family, compression, 'veryfast');
  return softwareArgs(family, compression, videoUsesAutoCRF(compression) ? 'slower' : videoH264Preset(compression));
}

/**
 * `videoConversionArgs` (Shared.swift): encoder arguments and container for an explicit codec
 * conversion. Without a compression value the historical fixed arguments apply. HEVC keeps the
 * hardware/software split: hardware for `fast` and for the fixed arguments (at the quality of the
 * legacy VideoToolbox -q:v 40), libx265 otherwise or when there is no hardware HEVC encoder.
 */
export function videoConversionArgs(codec: VideoCodecConversion, compression: CompressionQuality | undefined, hardwareHEVC?: string, tenBit = false): { args: string[]; ext: string } {
  const x265 = (cq: CompressionQuality) => ['-vcodec', 'libx265', '-crf', String(videoH265CRF(cq)), '-tag:v', 'hvc1', '-preset', videoH264Preset(cq)];
  const x265Fixed = (crf: number) => ['-vcodec', 'libx265', '-crf', String(crf), '-tag:v', 'hvc1', '-preset', 'medium'];
  switch (codec) {
    case 'hevc':
      if (!compression) return { args: hardwareHEVC ? hardwareArgs(hardwareHEVC, { tier: 'fast', factor: 64 }, tenBit) : x265Fixed(28), ext: 'mp4' };
      if (compression.tier === 'lossless') return { args: x265Fixed(18), ext: 'mp4' };
      if (compression.tier === 'fast' && hardwareHEVC) return { args: hardwareArgs(hardwareHEVC, compression, tenBit), ext: 'mp4' };
      return { args: x265(compression), ext: 'mp4' };
    case 'x265':
      if (!compression) return { args: x265Fixed(28), ext: 'mp4' };
      return { args: compression.tier === 'lossless' ? x265Fixed(18) : x265(compression), ext: 'mp4' };
    case 'av1':
      if (!compression) return { args: ['-vcodec', 'libsvtav1'], ext: 'mkv' };
      if (compression.tier === 'lossless') return { args: ['-vcodec', 'libsvtav1', '-crf', '22', '-preset', '6'], ext: 'mkv' };
      return { args: ['-vcodec', 'libsvtav1', '-crf', String(videoAV1CRF(compression)), '-preset', compression.factor >= 60 ? '6' : '8'], ext: 'mkv' };
    case 'webm': {
      const crf = !compression ? 31 : compression.tier === 'lossless' ? 15 : videoVP9CRF(compression);
      return { args: ['-vcodec', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1'], ext: 'webm' };
    }
  }
}
