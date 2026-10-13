import { decodePipelines, decodePresetZones } from '../core/pipeline/codec';
import { referenceTo, type Pipeline } from '../core/pipeline/model';
import { parseSteps } from '../core/pipeline/parser';
import type { ClopSettings } from '../core/settings/schema';

const pipeline = (id: string, name: string, text: string, fileType?: Pipeline['fileType'], icon?: string): Pipeline =>
  ({ id, name, steps: parseSteps(text, { fileType }), rawText: text, skipOptimisation: false, hideResult: false, fileType, icon });

/** Example pipelines, attachments and preset zones for the browser preview's editor (CLOP_PREVIEW_DEMO=1), used for screenshots. */
export function demoSettings(base: ClopSettings): Partial<ClopSettings> {
  const web = pipeline('DEMO-WEB', 'Web ready', 'if(types: png jpeg) -> downscale(factor: 0.5) -> convert(to: webp) -> move(to: "~/Pictures/Web/%y/%m/")', 'image', 'cloud');
  const social = pipeline('DEMO-SOCIAL', 'Square for social', 'crop(width: 1080, height: 1080, smartCrop: true) -> optimise(encoder: aggressive)', 'image', 'heart');
  const script = { id: 'DEMO-SCRIPT', name: 'Notify', steps: [{ runScript: { code: 'Write-Host "Optimised $env:CLOP_FILE -> done"' } }], skipOptimisation: false, hideResult: false, icon: 'bolt' } as unknown as Pipeline;
  const saved = decodePipelines([...base.savedPipelines, web, social, script, { id: 'DEMO-FUTURE', name: 'Newer macOS step', steps: [{ teleport: { to: 'moon' } }] }])!;
  return {
    savedPipelines: saved,
    imageDirs: ['~/Desktop', '~/Pictures/Screenshots'],
    pipelinesToRunOnImage: { clipboard: [referenceTo(web)], dropZone: [referenceTo(social)], '~/Pictures/Screenshots': [referenceTo(web)] },
    pipelinesToRunOnVideo: { clipboard: [referenceTo(base.savedPipelines.filter((entry): entry is Pipeline => !('reason' in entry)).find(entry => entry.id === 'builtin-video-1080p')!)] },
    presetZones: decodePresetZones([
      { id: 'Z1', name: 'Web ready', icon: 'cloud', type: 'image', pipeline: referenceTo(web) },
      { id: 'Z2', name: 'Square', icon: 'heart', type: 'image', pipeline: referenceTo(social) },
      { id: 'Z3', name: 'to GIF', icon: 'photo.on.rectangle.angled', type: 'video', pipeline: referenceTo(base.savedPipelines.filter((entry): entry is Pipeline => !('reason' in entry)).find(entry => entry.id === 'builtin-video-to-gif')!) },
      { id: 'Z4', name: 'Notify', icon: 'bolt', pipeline: referenceTo(script) },
    ])!,
  };
}
