import { run, ToolError } from '../run';

// Tag lists from ClopUtils.swift and Shared.swift.
export const PNG_PHYS_TAGS = ['PixelsPerUnitX', 'PixelsPerUnitY', 'PixelUnits'];
export const RESOLUTION_TAGS = ['-XResolution', '-YResolution', '-ResolutionUnit', ...PNG_PHYS_TAGS.map(tag => `-${tag}`)];
export const COLOUR_TAGS = ['-ColorSpaceTags', '-icc_profile', '-WhitePoint', '-PrimaryChromaticities'];

/**
 * Removes identifying metadata in place, keeping resolution, orientation and (optionally) the colour
 * profile, with the arguments of `FilePath.stripExif`. A file exiftool cannot write is left as the
 * optimiser wrote it, as on macOS.
 */
export async function stripExif(file: string, { preserveColour = true, signal }: { preserveColour?: boolean; signal?: AbortSignal } = {}) {
  const args = ['-charset', 'filename=utf8', '-overwrite_original', '-XResolution=72', '-YResolution=72', '-all=', '-tagsFromFile', '@', ...RESOLUTION_TAGS, '-Orientation', ...(preserveColour ? COLOUR_TAGS : []), file];
  try { await run('exiftool', args, { signal }); } catch (error) { if (!(error instanceof ToolError)) throw error; }
}
