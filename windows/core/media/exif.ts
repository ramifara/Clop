import { run, ToolError } from '../run';

// Tag lists from ClopUtils.swift and Shared.swift.
export const PNG_PHYS_TAGS = ['PixelsPerUnitX', 'PixelsPerUnitY', 'PixelUnits'];
export const RESOLUTION_TAGS = ['-XResolution', '-YResolution', '-ResolutionUnit', ...PNG_PHYS_TAGS.map(tag => `-${tag}`)];
export const COLOUR_TAGS = ['-ColorSpaceTags', '-icc_profile', '-WhitePoint', '-PrimaryChromaticities'];
/** The colour description a result keeps from its own encoder when metadata is copied (the tags `copyExifCGImage` removes, plus the profile). */
const OWN_COLOUR_TAGS = ['ICC_Profile', 'ColorSpace', 'Gamma', 'WhitePoint', 'PrimaryChromaticities', 'YCbCrCoefficients', 'TransferFunction', 'ReferenceBlackWhite'];

/** Runs exiftool; a file it cannot write is left as the optimiser wrote it, as on macOS. */
async function exiftool(file: string, args: string[], signal?: AbortSignal) {
  // A bare JXL codestream has nowhere to keep metadata; exiftool wraps it in a container only past that "minor" warning.
  const wrap = /\.jxl$/i.test(file) ? ['-m'] : [];
  try { await run('exiftool', ['-charset', 'filename=utf8', '-overwrite_original', ...wrap, ...args, file], { signal }); } catch (error) { if (!(error instanceof ToolError)) throw error; }
}

/**
 * Removes identifying metadata in place, keeping resolution, orientation and (optionally) the colour
 * profile, with the arguments of `FilePath.stripExif`.
 */
export async function stripExif(file: string, { preserveColour = true, signal }: { preserveColour?: boolean; signal?: AbortSignal } = {}) {
  await exiftool(file, ['-XResolution=72', '-YResolution=72', '-all=', '-tagsFromFile', '@', ...RESOLUTION_TAGS, '-Orientation', ...(preserveColour ? COLOUR_TAGS : [])], signal);
}

export interface CopyMetadataOptions {
  /** `stripMetadata`: keep only resolution and orientation from `source`, and the result's own colour profile with `preserveColour`. */
  strip?: boolean; preserveColour?: boolean;
  /** The result has `source`'s pixels as stored, so `source`'s orientation tag still applies. Re-encoded results are already upright. */
  sameOrientation?: boolean;
  animated?: boolean;
  signal?: AbortSignal;
}

/**
 * `FilePath.copyExif` on exiftool alone: gives a result the metadata of the image it came from. With
 * `strip` that is only the resolution tags (both EXIF and PNG pHYs, so the DPI survives) and the
 * orientation; otherwise every tag. Either way the colour description stays the result's own, since
 * it has to describe the result's pixels.
 */
export async function copyMetadata(file: string, source: string, { strip = true, preserveColour = true, sameOrientation = false, animated = false, signal }: CopyMetadataOptions = {}) {
  const orientation = sameOrientation ? ['-Orientation'] : [];
  if (strip) return exiftool(file, ['-all=', ...(preserveColour ? ['-tagsFromFile', '@', ...COLOUR_TAGS] : []), '-tagsFromFile', source, ...RESOLUTION_TAGS, ...orientation], signal);
  const exclude = [...OWN_COLOUR_TAGS, ...(sameOrientation ? [] : ['Orientation'])].map(tag => `--${tag}`);
  await exiftool(file, ['-tagsFromFile', source, ...(animated ? ['-All:All'] : []), ...exclude], signal);
}
