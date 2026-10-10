import { findSaved, invalidPipelineSteps, unknownPipelineMessage } from '../core/pipeline/library';
import { parseSettings, type ClopSettings } from '../core/settings/schema';
import { ValidationError } from './args';
import type { Context } from './context';

/** Every setting as stored, from the running app or the settings file. */
export async function readSettings(ctx: Context): Promise<ClopSettings> {
  const response = await (await ctx.backend()).settings({ action: 'read', origin: ctx.origin });
  if (!response.ok || !response.values) throw new Error(response.error ?? 'Clop did not answer.');
  return parseSettings(response.values);
}

/** `pipeline run` validation: a saved pipeline's name, or inline steps whose step names all exist. */
export async function checkPipelineArgument(ctx: Context, arg: string) {
  const settings = await readSettings(ctx);
  if (findSaved(settings, arg, false)) return;
  const unknown = invalidPipelineSteps(arg);
  if (unknown.length) throw new ValidationError(unknownPipelineMessage(settings, arg, unknown));
}
