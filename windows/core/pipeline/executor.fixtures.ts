import type { TestContext } from 'node:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OptimisedMarker } from '../marker';
import { defaultSettings, type ClopSettings } from '../settings/schema';
import { needTools } from '../testing';
import { Workdir } from '../workdir';
import { runPipeline, type PipelineEffects, type PipelineRunOptions } from './executor';
import type { ClopFileType, PipelineStep } from './model';
import { parseSteps } from './parser';

/** Records what the pipeline asked the app to do. `openWith` fails for an app called Missing, as the app does for one it cannot find. */
export class FakeEffects implements PipelineEffects {
  clipboard: ({ text: string } | { image: string })[] = [];
  opened: [string, string][] = [];
  trashed: [string, 'file' | 'folder'][] = [];
  async copyToClipboard(item: { text: string } | { image: string }) { this.clipboard.push(item); }
  async openWith(file: string, app: string) { if (app === 'Missing') throw new Error(`App '${app}' not found`); this.opened.push([file, app]); }
  async trash(target: string, kind: 'file' | 'folder') { this.trashed.push([target, kind]); await rm(target, { recursive: true }); return true; }
}

const TYPES: Record<string, ClopFileType> = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', mp4: 'video', mov: 'video', pdf: 'pdf', wav: 'audio', m4a: 'audio', mp3: 'audio' };

/** A folder for input files, a work directory, a marker and fake effects; `run` runs pipeline text (or steps) on a file. */
export async function pipelineWorkspace(t: TestContext, ...tools: Parameters<typeof needTools>[1][]) {
  if (tools.length && !needTools(t, ...tools)) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-pipeline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = path.join(dir, 'files');
  await mkdir(files);
  const workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const marker = new OptimisedMarker(path.join(dir, 'optimised.json'));
  const effects = new FakeEffects(), counter = { value: 0 };
  const settings: ClopSettings = defaultSettings();
  const run = (pipeline: string | PipelineStep[], input: string, opts: Partial<PipelineRunOptions> = {}) => runPipeline(
    { id: 'TEST', steps: typeof pipeline === 'string' ? parseSteps(pipeline) : pipeline, skipOptimisation: true, hideResult: false }, input,
    { fileType: TYPES[path.extname(input).slice(1).toLowerCase()], env: { settings, workdir, counter, marker }, effects, allowScripts: true, ...opts },
  );
  return {
    dir, files, workdir, marker, effects, settings, counter, run,
    file: (name: string) => path.join(files, name),
    /** Everything left in the work directory's temp folder. */
    temp: async () => (await readdir(workdir.temp, { recursive: true })).map(String),
    backups: async () => readdir(workdir.backups),
  };
}
/** A path inside pipeline text: forward slashes read the same on every platform. */
export const quoted = (file: string) => `"${file.replaceAll('\\', '/')}"`;
