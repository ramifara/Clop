import type { MediaName } from '../../core/settings/entries';

// How the Settings window reads the pipelines in the settings: only enough to name them. A pipeline the app could not read arrives as
// `{ raw, reason }` (the `Unreadable` of core/pipeline/codec.ts, after crossing the process boundary).

export const PIPELINE_SOURCE_KEYS_FOR_UI = { image: 'pipelinesToRunOnImage', video: 'pipelinesToRunOnVideo', pdf: 'pipelinesToRunOnPdf', audio: 'pipelinesToRunOnAudio' } as const satisfies Record<MediaName, string>;
export interface ReadablePipeline { id: string; name?: string; rawText?: string; libraryID?: string; fileType?: MediaName; details?: string }
export type PipelineLike = ReadablePipeline | { reason: string; raw?: unknown };

/** A pipeline's name; a reference to a saved pipeline takes the saved one's name, and one with no name reads as its text. */
export function pipelineLabel(pipeline: PipelineLike, saved: readonly PipelineLike[] = []): string {
  if ('reason' in pipeline) return 'Unreadable pipeline';
  const target = pipeline.libraryID ? saved.find((other): other is ReadablePipeline => !('reason' in other) && other.id === pipeline.libraryID) : undefined;
  const source = target ?? pipeline;
  return source.name?.trim() || source.rawText?.split('\n')[0]?.slice(0, 60) || 'Pipeline';
}
