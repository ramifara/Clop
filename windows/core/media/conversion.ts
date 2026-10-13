import { settingsSchema } from '../settings/schema';

// The automatic conversions the Compatibility settings choose (`autoConversionFormat` in ImagePipeline.swift, `forceMP4` in VideoPipeline.swift).
const ALIASES: Record<string, string> = { jpg: 'jpeg', jpe: 'jpeg', tif: 'tiff', heif: 'heic', mpeg: 'mpg', qt: 'mov' };
const canonical = (ext: string) => { const lower = ext.replace(/^\./, '').toLowerCase(); return ALIASES[lower] ?? lower; };
const listed = (list: readonly string[], ext: string) => list.some(item => canonical(item) === canonical(ext));

export interface ImageConversionSettings { formatsToConvertToJPEG?: readonly string[]; formatsToConvertToPNG?: readonly string[] }
export interface VideoConversionSettings { formatsToConvertToMP4?: readonly string[] }

/** The format an image of type `ext` is converted to before optimising: JPEG first, then PNG, else undefined. A missing list is the setting's default. */
export function imageConversionTarget(ext: string, settings: ImageConversionSettings = {}): 'jpeg' | 'png' | undefined {
  const target = listed(settings.formatsToConvertToJPEG ?? settingsSchema.formatsToConvertToJPEG.default as string[], ext) ? 'jpeg'
    : listed(settings.formatsToConvertToPNG ?? settingsSchema.formatsToConvertToPNG.default as string[], ext) ? 'png' : undefined;
  return target === canonical(ext) ? undefined : target;
}

/** Whether a video of type `ext` becomes an MP4 (`formatsToConvertToMP4`). Only a caller that passes the list converts: pipeline steps and card edits keep the container. */
export const convertsToMP4 = (ext: string, settings: VideoConversionSettings = {}) => canonical(ext) !== 'mp4' && listed(settings.formatsToConvertToMP4 ?? [], ext);
