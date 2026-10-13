import path from 'node:path';
import { isReadable, type Stored } from '../core/pipeline/codec';
import { addPipeline, addPresetZone, attachPipeline, deletePipeline, detachPipeline, LibraryError, removePresetZone, type LibraryEdit } from '../core/pipeline/library';
import type { Pipeline } from '../core/pipeline/model';
import { formatSteps, PipelineError } from '../core/pipeline/parser';
import { pipelinePrompt } from '../core/pipeline/reference';
import { PIPELINE_SOURCE_KEYS } from '../core/pipeline/triggers';
import { SETTINGS_CHANGED } from '../core/ipc/protocol';
import { portablePath } from '../core/settings/paths';
import type { ClopSettings } from '../core/settings/schema';
import { shellEffects } from '../core/shell-effects';
import { resolveHome } from '../core/template';
import { ValidationError } from './args';
import { bold, CHECKMARK, dim, green, red, yellow } from './colors';
import { flag, on, option, str, type ClopCommand, type Context } from './context';
import { pipelineRunCommand } from './optimise';
import { readSettings, readStored } from './read-settings';
import { shellString, sortedJSON } from './results';

// `clop pipeline …` (ClopCLI/main.swift). Reads come from the running app or the settings file; writes go through the app
// when it runs, so it applies them at once and nothing it saves later overwrites them.

// The change is built from the settings as read, and saved as one `update` that names the values it was built on: if the
// pipeline editor or another command saved one of them in between, the app refuses it and the edit is built again from the
// new settings, so neither side loses the other's change.
const WRITE_ATTEMPTS = 4;
async function write(ctx: Context, edit: (settings: ClopSettings) => LibraryEdit, pipeline?: string) {
  for (let attempt = 1; ; attempt++) {
    const { settings, stored } = await readStored(ctx);
    let result: LibraryEdit;
    try { result = edit(settings); } catch (error) { if (error instanceof LibraryError || error instanceof PipelineError) throw new ValidationError((error as Error).message); throw error; }
    const base = Object.fromEntries([...Object.keys(result.values), ...result.read ?? []].map(key => [key, stored[key]]));
    const response = await (await ctx.backend()).settings({ action: 'update', values: result.values, base, origin: ctx.origin, pipeline });
    if (response.ok) return result;
    if (response.error !== SETTINGS_CHANGED || attempt >= WRITE_ATTEMPTS) throw new ValidationError(response.error ?? 'Clop refused the change.');
  }
}
const PAINT = { name: green, source: yellow };

/** `CLIPipeline`: the fields the CLI shows, read loosely so an entry this version cannot run is still listed. */
interface Listed { id: string; name?: string; rawText?: string; steps?: Pipeline['steps']; skipOptimisation?: boolean; hideResult?: boolean; libraryID?: string; fileType?: string; raw: unknown }
function listed(entry: Stored<Pipeline>): Listed | undefined {
  if (isReadable(entry)) return { ...entry, raw: entry };
  let raw = entry.raw;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return undefined; } }
  const r = raw as Record<string, unknown>;
  if (typeof r?.id !== 'string') return undefined;
  const text = (key: string) => typeof r[key] === 'string' ? r[key] as string : undefined;
  return { id: r.id, name: text('name'), rawText: text('rawText'), libraryID: text('libraryID'), fileType: text('fileType'), skipOptimisation: r.skipOptimisation === true, hideResult: r.hideResult === true, raw };
}
const displayText = (p: Listed) => p.rawText || (p.steps?.length ? formatSteps(p.steps) : p.steps ? '(no steps)' : '(cannot be read by this version)');
const provenance = (p: Listed) => p.libraryID !== undefined ? 'reference' : p.id.startsWith('builtin-') ? 'builtin' : 'user';
const flagTags = (p: Listed) => { const tags = [p.skipOptimisation && 'Skip optimisation', p.hideResult && 'Hide result'].filter(Boolean) as string[]; return tags.length ? ` ${tags.map(tag => dim(`[${tag}]`)).join(' ')}` : ''; };


const AUTOMATIONS = [['image', 'images', 'imageDirs'], ['video', 'videos', 'videoDirs'], ['pdf', 'PDFs', 'pdfDirs'], ['audio', 'audio', 'audioDirs']] as const;

const list: ClopCommand = {
  name: 'list', abstract: 'List saved pipelines and folder automations.',
  options: [flag('json', 'Output as JSON', 'j'), flag('all', 'Also show hidden entries: orphaned folder automations (folder no longer watched), empty pipelines, and broken references')],
  async run(v, ctx) {
    const settings = await readSettings(ctx), saved = settings.savedPipelines.flatMap(entry => listed(entry) ?? []), out = (line: string) => ctx.io.out(`${line}\n`);
    if (on(v, 'json')) {
      const automations: Record<string, unknown> = {};
      for (const [type, label] of AUTOMATIONS) {
        const attached = settings[PIPELINE_SOURCE_KEYS[type]];
        if (Object.keys(attached).length) automations[label] = Object.fromEntries(Object.entries(attached).map(([source, pipelines]) => [source, pipelines.flatMap(p => listed(p)?.raw ?? [])]));
      }
      out(sortedJSON({ saved: saved.map(p => p.raw), automations }));
      return;
    }
    if (!saved.length) out(dim('No saved pipelines'));
    else {
      out(bold('Saved pipelines:'));
      for (const p of saved) {
        out(`  ${green(p.name ?? p.id)} (${yellow(p.fileType ?? 'any')})${provenance(p) === 'builtin' ? ` ${dim('built-in')}` : ''}${flagTags(p)}`);
        out(`    ${displayText(p)}`);
      }
    }
    const portable = (dir: string) => portablePath(path.resolve(resolveHome(dir, ctx.home)), ctx.home);
    for (const [type, label, dirsKey] of AUTOMATIONS) {
      const attached = settings[PIPELINE_SOURCE_KEYS[type]], watched = settings[dirsKey].map(portable), lines: string[] = [];
      for (const source of Object.keys(attached).sort()) for (const entry of attached[source]) {
        const raw = listed(entry);
        if (!raw) continue;
        const resolved = raw.libraryID !== undefined ? saved.find(p => p.id === raw.libraryID) ?? raw : raw;
        // `hiddenReason`: a reference to a deleted pipeline, a pipeline with no steps, or a folder no longer watched.
        const hidden = provenance(raw) === 'reference' && resolved === raw || displayText(resolved) === '(no steps)' ? 'missing'
          : /^([~/\\]|[a-z]:)/i.test(source) && !watched.includes(portable(source)) ? 'orphaned' : undefined;
        if (hidden && !on(v, 'all')) continue;
        lines.push(`  ${yellow(shellString(source, ctx.home))}${resolved.name ? ` -> ${green(resolved.name)}` : ''}${provenance(raw) === 'reference' ? ` ${dim('reference')}` : ''}${hidden ? ` ${red(hidden)}` : ''}${flagTags(resolved)}`);
        lines.push(`    ${displayText(resolved)}`);
      }
      if (!lines.length) continue;
      out(`\nAutomations for ${bold(label)}:`);
      for (const line of lines) out(line);
    }
  },
};

const show: ClopCommand = {
  name: 'show', abstract: 'Show the steps of a saved pipeline.',
  options: [flag('json', 'Output the raw pipeline JSON', 'j')], arguments: [{ name: 'name', help: 'Name of the saved pipeline' }],
  async run(v, ctx) {
    const name = str(v, 'name')!, settings = await readSettings(ctx);
    const p = settings.savedPipelines.flatMap(entry => listed(entry) ?? []).find(entry => entry.name?.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
    if (!p) throw new ValidationError(`No saved pipeline named '${name}'. Use \`clop pipeline list\` to see available pipelines.`);
    ctx.io.out(`${on(v, 'json') ? sortedJSON(p.raw) : displayText(p)}\n`);
  },
};

const add: ClopCommand = {
  name: 'add', abstract: 'Save a pipeline to the library so it can be run by name and used in the app.',
  options: [
    option('fileType', 'File type this pipeline applies to (image, video, pdf, audio). Omit for any type.'),
    flag('skipOptimisation', 'Skip optimisation. Pass the original file straight into the pipeline (use when convert/downscale/crop already shrink it)'),
    flag('hideResult', 'Hide result. Run silently without showing the floating result thumbnail'),
    flag('force', 'Replace an existing pipeline with the same name'),
  ],
  arguments: [{ name: 'name', help: 'Name for the pipeline' }, { name: 'steps', help: "Pipeline steps, e.g. 'crop(width: 1600) -> convert(to: webp)'" }],
  async run(v, ctx) {
    const steps = str(v, 'steps')!;
    const edit = await write(ctx, settings => addPipeline(settings, { name: str(v, 'name')!, steps, fileType: str(v, 'fileType'), skipOptimisation: on(v, 'skipOptimisation'), hideResult: on(v, 'hideResult'), force: on(v, 'force') }, ctx.home, PAINT), steps);
    ctx.io.out(`${CHECKMARK()} ${edit.message}\n`);
  },
};

const remove: ClopCommand = {
  name: 'delete', abstract: 'Delete a saved pipeline.', arguments: [{ name: 'name', help: 'Name of the saved pipeline to delete' }],
  async run(v, ctx) {
    const edit = await write(ctx, settings => deletePipeline(settings, str(v, 'name')!, PAINT));
    ctx.io.out(`${CHECKMARK()} ${edit.message}\n`);
  },
};

const prompt: ClopCommand = {
  name: 'prompt', abstract: 'Print an LLM-ready reference of the pipeline DSL: every step, parameter, value set, caveat, and how to run or save a pipeline.',
  discussion: `Feed it to an LLM so it can author Clop pipelines for you. Append your request as
the final argument and use -c/--copy to place the whole thing on the clipboard:

    clop pipeline prompt -c "shrink all my screenshots to webp under 500KB"

The LLM should reply with a single line: a bare pipeline string to run with
\`clop pipeline run\`, or a full \`clop pipeline add\`/\`attach\` command when the request
is to save or automate it.

Use --compact for a much shorter prompt (~1.7k tokens) that fits small-context,
on-device models; the default prompt is richer (~5.3k tokens) and suits larger models.`,
  options: [flag('copy', 'Copy the generated prompt to the clipboard', 'c'), flag('compact', 'Emit a shorter prompt that fits small-context models (e.g. on-device models limited to ~4k tokens)')],
  arguments: [{ name: 'task', help: 'Optional task appended to the end as the request for the LLM', variadic: true }],
  async run(v, ctx) {
    const task = ((v.task as string[] | undefined) ?? []).join(' ').trim();
    const text = pipelinePrompt(task || undefined, on(v, 'compact'));
    ctx.io.out(`${text}\n`);
    if (on(v, 'copy')) { await shellEffects().copyToClipboard({ text }); ctx.io.err(`\n${CHECKMARK()} Copied prompt to clipboard.\n`); }
  },
};

const attach: ClopCommand = {
  name: 'attach', abstract: 'Attach a pipeline to a source (clipboard, dropZone, or a folder path) for a specific file type.',
  options: [
    option('source', 'Source to attach to: clipboard, dropZone, or an absolute folder path.', undefined, { required: true }),
    option('type', 'File type: image, video, pdf, or audio.', undefined, { required: true }),
    flag('skipOptimisation', 'Skip optimisation pass before the pipeline runs.'), flag('hideResult', 'Hide the floating result thumbnail.'),
  ],
  arguments: [{ name: 'pipeline', help: "Saved pipeline name/id or inline steps, e.g. 'crop(width: 1600) -> convert(to: webp)'." }],
  async run(v, ctx) {
    const arg = str(v, 'pipeline')!;
    const edit = await write(ctx, settings => attachPipeline(settings, { pipeline: arg, source: str(v, 'source')!, type: str(v, 'type')!, skipOptimisation: on(v, 'skipOptimisation'), hideResult: on(v, 'hideResult') }, ctx.home, PAINT), arg);
    ctx.io.out(`${CHECKMARK()} ${edit.message}${edit.notes?.length ? dim(` (${edit.notes.join(', ')})`) : ''}\n`);
  },
};

const detach: ClopCommand = {
  name: 'detach', abstract: 'Remove one or all pipelines attached to a source/type.',
  options: [
    option('source', 'Source: clipboard, dropZone, or an absolute folder path.', undefined, { required: true }),
    option('type', 'File type: image, video, pdf, or audio.', undefined, { required: true }),
    option('index', '0-based index of the pipeline to remove. Mutually exclusive with --all.'),
    flag('all', 'Remove all pipelines for this source/type. Mutually exclusive with --index.'),
  ],
  async run(v, ctx) {
    const index = str(v, 'index');
    if (index !== undefined && !/^-?\d+$/.test(index)) throw new ValidationError(`The value '${index}' is invalid for '--index <index>'`);
    const edit = await write(ctx, settings => detachPipeline(settings, { source: str(v, 'source')!, type: str(v, 'type')!, index: index === undefined ? undefined : Number(index), all: on(v, 'all') }, ctx.home, PAINT));
    ctx.io.out(`${CHECKMARK()} ${edit.message}\n${edit.notes?.map(note => `  ${dim(note)}\n`).join('') ?? ''}`);
  },
};

const presetAdd: ClopCommand = {
  name: 'add', abstract: 'Add a preset zone to the drop zone.',
  options: [
    option('type', 'File type this preset applies to: image, video, pdf, or audio. Omit for all types.'),
    option('icon', 'Icon name for the preset zone (an SF Symbol name, as on macOS).'),
    flag('skipOptimisation', 'Skip optimisation pass before the pipeline runs.'), flag('hideResult', 'Hide the floating result thumbnail.'),
    flag('force', 'Replace an existing preset zone with the same id.'),
  ],
  arguments: [{ name: 'name', help: 'Name of the preset zone.' }, { name: 'pipeline', help: "Saved pipeline name/id or inline steps, e.g. 'convert(to: webp)'." }],
  async run(v, ctx) {
    const arg = str(v, 'pipeline')!;
    const edit = await write(ctx, settings => addPresetZone(settings, { name: str(v, 'name')!, pipeline: arg, type: str(v, 'type'), icon: str(v, 'icon'), skipOptimisation: on(v, 'skipOptimisation'), hideResult: on(v, 'hideResult'), force: on(v, 'force') }, ctx.home, PAINT), arg);
    ctx.io.out(`${CHECKMARK()} ${edit.message}\n`);
  },
};

const presetRemove: ClopCommand = {
  name: 'remove', abstract: 'Remove a preset zone by name (and optional type).',
  options: [option('type', "File type of the preset zone: image, video, pdf, or audio. Omit for the 'all types' zone.")],
  arguments: [{ name: 'name', help: 'Name of the preset zone to remove.' }],
  async run(v, ctx) {
    const edit = await write(ctx, settings => removePresetZone(settings, { name: str(v, 'name')!, type: str(v, 'type') }, PAINT));
    ctx.io.out(`${CHECKMARK()} ${edit.message}\n`);
  },
};

export const pipelineCommand: ClopCommand = {
  name: 'pipeline', abstract: 'Manage and run Clop pipelines (saved presets and inline step sequences).',
  subcommands: [list, show, pipelineRunCommand, add, remove, prompt, attach, detach, { name: 'preset', abstract: 'Manage drop zone preset zones.', subcommands: [presetAdd, presetRemove] }],
};
