import type { MenuItemConstructorOptions } from 'electron';
import type { MediaKind } from '../core/media/types';
import type { PipelineChoice } from '../src/types';

/**
 * The menu the "Run pipeline..." Explorer verb opens: the saved pipelines that work on at least one of the files' kinds (a pipeline for
 * every type works on all), under a line saying how many files they will run on. No entry means nothing fits.
 */
export function pipelineMenu(choices: readonly PipelineChoice[], kinds: readonly (MediaKind | undefined)[], count: number, pick: (id: string) => void): MenuItemConstructorOptions[] {
  const present = new Set(kinds), usable = choices.filter(choice => !choice.fileType || present.has(choice.fileType));
  if (!usable.length) return [];
  return [
    { label: `Run on ${count} file${count === 1 ? '' : 's'}`, enabled: false },
    { type: 'separator' },
    ...usable.map(choice => ({ label: choice.name, toolTip: choice.text, click: () => pick(choice.id) })),
  ];
}
