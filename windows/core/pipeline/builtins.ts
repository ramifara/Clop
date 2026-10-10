import { isReadable, storedId, type Stored } from './codec';
import type { ClopFileType, Pipeline } from './model';
import { parseSteps } from './parser';

// BUILTIN_PIPELINE_DEFS and seedBuiltinPipelines (Clop/Pipeline.swift). The texts are byte-for-byte the macOS ones, so a
// library synced or exported from a Mac matches. Their paths are portable: `~` is the user profile folder on Windows, so
// "Sort screenshots" files into %USERPROFILE%\Pictures\Screenshots\<year>\<month>, the folder Windows saves screenshots to.

export interface BuiltinPipelineDef { id: string; name: string; fileType: ClopFileType; rawText: string; skipOptimisation: boolean; icon: string; details: string; version: number }

export const BUILTIN_PIPELINE_DEFS: readonly BuiltinPipelineDef[] = [
  { id: 'builtin-image-webp', name: 'to WebP', fileType: 'image', rawText: 'convert(to: webp)', skipOptimisation: true, icon: 'photo', details: 'Convert images to the compact WebP format', version: 1 },
  { id: 'builtin-image-sort-screenshots', name: 'Sort screenshots', fileType: 'image', rawText: 'if(regex: "^(screen\\s?shot|cleanshot)") -> optimise() -> move(to: "~/Pictures/Screenshots/%y/%m/")', skipOptimisation: true, icon: 'folder', details: 'Optimise screenshots and file them under ~/Pictures/Screenshots/year/month', version: 1 },
  { id: 'builtin-image-half', name: '0.5×', fileType: 'image', rawText: 'downscale(factor: 0.5)', skipOptimisation: true, icon: 'arrow.down.right.and.arrow.up.left', details: 'Halve the image resolution', version: 1 },
  { id: 'builtin-image-watermark', name: 'Watermark', fileType: 'image', rawText: 'watermark(image: "%P/watermark.png")', skipOptimisation: true, icon: 'signature', details: 'Overlay watermark.png from the same folder onto the image', version: 1 },
  { id: 'builtin-video-1080p', name: '1080p', fileType: 'video', rawText: 'crop(width: 1920) -> optimise(encoder: slowHighQuality)', skipOptimisation: true, icon: 'tv', details: 'Scale video to 1920px wide and optimise', version: 1 },
  { id: 'builtin-video-to-gif', name: 'to GIF', fileType: 'video', rawText: 'crop(longEdge: 800) -> convert(to: gif)', skipOptimisation: true, icon: 'photo.on.rectangle.angled', details: 'Crop to 800px and convert to an animated GIF', version: 1 },
  { id: 'builtin-video-2x-silent', name: '2× silent', fileType: 'video', rawText: 'changeSpeed(factor: 2.0) -> removeAudio -> optimise(encoder: fast)', skipOptimisation: true, icon: 'speaker.slash.fill', details: 'Double the playback speed and remove the audio', version: 1 },
  { id: 'builtin-video-half', name: '0.5×', fileType: 'video', rawText: 'downscale(factor: 0.5)', skipOptimisation: true, icon: 'arrow.down.right.and.arrow.up.left', details: 'Halve the video resolution', version: 1 },
  { id: 'builtin-video-watermark', name: 'Watermark', fileType: 'video', rawText: 'watermark(image: "%P/watermark.png")', skipOptimisation: true, icon: 'signature', details: 'Overlay watermark.png from the same folder onto the video', version: 1 },
  { id: 'builtin-pdf-as-images', name: 'as images', fileType: 'pdf', rawText: 'extractPagesAsImages(format: jpeg, quality: high)', skipOptimisation: true, icon: 'photo.stack', details: 'Extract each PDF page as a JPEG image', version: 1 },
  { id: 'builtin-audio-to-mp3', name: 'to MP3', fileType: 'audio', rawText: 'convert(to: mp3)', skipOptimisation: true, icon: 'music.note', details: 'Convert any audio file to MP3', version: 1 },
];

/** Bumped when a release adds built-ins; `builtinPipelinesSeededVersion` remembers the last one seeded. */
export const BUILTIN_PIPELINES_VERSION = 2;

/** The saved pipeline a definition seeds, as macOS stores it. */
export const builtinPipeline = (def: BuiltinPipelineDef): Pipeline => ({
  id: def.id, steps: parseSteps(def.rawText, { fileType: def.fileType }), name: def.name, rawText: def.rawText,
  skipOptimisation: def.skipOptimisation, hideResult: false, fileType: def.fileType, icon: def.icon, details: def.details,
});

/**
 * `seedBuiltinPipelines`: adds the built-ins newer than `seededVersion` to the library, once per version, so a built-in the
 * user deleted stays deleted. Built-ins already present only get a missing icon or details filled in; one this version
 * cannot read is kept as it is and not added again. Returns undefined when the library is already seeded at this version.
 */
export function seedBuiltinPipelines(saved: readonly Stored<Pipeline>[], seededVersion: number): { savedPipelines: Stored<Pipeline>[]; builtinPipelinesSeededVersion: number } | undefined {
  if (seededVersion >= BUILTIN_PIPELINES_VERSION) return undefined;
  const savedPipelines = [...saved];
  for (const def of BUILTIN_PIPELINE_DEFS) {
    const index = savedPipelines.findIndex(entry => storedId(entry) === def.id), entry = savedPipelines[index];
    if (index < 0) { if (def.version > seededVersion) savedPipelines.push(builtinPipeline(def)); }
    else if (isReadable(entry)) savedPipelines[index] = { ...entry, icon: entry.icon ?? def.icon, details: entry.details ?? def.details };
  }
  return { savedPipelines, builtinPipelinesSeededVersion: BUILTIN_PIPELINES_VERSION };
}
