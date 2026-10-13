import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { requireLocalDrive, requireNotRemote } from '../local-path';
import { defaultMarker } from '../marker';
import type { PlacementEnv, PlacementOverride } from '../placement';
import { expandTemplate, resolveHome } from '../template';
import type { ClopFileType, PipelineStep } from './model';

// What one pipeline run carries from step to step: `PipelineExecution` (Clop/PipelineExecution.swift) without the UI.

/** App-side actions the headless executor cannot do itself. The Electron app implements them; tests pass a fake. */
export interface PipelineEffects {
  /** Puts text, or the pixels of an image file, on the clipboard, marked as Clop's own so the clipboard watcher skips it. */
  copyToClipboard(item: { text: string } | { image: string }): Promise<void>;
  /** Opens `file` with an app: a name, an .exe path or an app ID. Rejects with a readable message when there is no such app. */
  openWith(file: string, app: string): Promise<void>;
  /** Moves a file or folder to the Recycle Bin. The app may ask before a folder goes; false means it stays. */
  trash(target: string, kind: 'file' | 'folder'): Promise<boolean>;
}

export interface PipelineProgress {
  /** Index of the running step; a pass of several steps reports its first. */
  step: number;
  steps: number;
  /** The step as pipeline text. */
  text: string;
  /** 0 when the step starts, 1 when it is done. */
  fraction: number;
}

export interface PipelineRunOptions {
  /** What the input is, which decides how each step treats it (`ClopFileType`). */
  fileType: ClopFileType;
  /** Settings, work directory, `%i` counter (write it back to `lastAutoIncrementingNumber`) and the optimised marker. */
  env: PlacementEnv;
  effects: PipelineEffects;
  /** Whether `runScript` and `runShortcut` may run. The caller decides, as `mcpAllowScriptSteps` does for agents. */
  allowScripts: boolean;
  /**
   * For an agent: a location that names a file that already exists is refused, so a result never lands on a user's file.
   * `settingsStep` is the step the user's own placement settings added, whose location may meet an earlier result.
   */
  refuseExisting?: { settingsStep?: PipelineStep };
  /** Where `runShortcut(name:)` finds its scripts; `%APPDATA%\Clop for Windows\scripts` by default. */
  scriptsDir?: string;
  /** The app that copied a clipboard item, for `if(copiedBy:)`: its executable path or app ID, and its name. */
  sourceApp?: { id?: string; name?: string };
  /** A per-request placement (CLI `--convert-behaviour`), which a `convert` step's default location follows. */
  placementOverride?: PlacementOverride;
  /** A plain optimisation (a command-line or agent request), which turns the video types `formatsToConvertToMP4` lists into MP4 as the app's own optimisation does. Pipelines and card edits keep the container. */
  convertContainers?: boolean;
  /** Another pipeline runs on the same file after this one, so a `fork` keeps a copy even when no later step of this one changes the file. */
  laterPipelines?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: PipelineProgress) => void;
}

export class RunState {
  readonly original: string;
  current: string;
  /** `$1`, `$2`… from the last matching `if(regex:)`. */
  captures: string[] = [];
  readonly forks: string[] = [];
  readonly pages: string[] = [];
  /** Things that went wrong without stopping the run, for the app to show. */
  readonly warnings: string[] = [];
  private root?: string;
  private unprotect?: () => void;
  private scratchCount = 0;

  constructor(input: string, readonly opts: PipelineRunOptions) { this.original = this.current = path.resolve(input); }
  get settings() { return this.opts.env.settings; }
  get fileType() { return this.opts.fileType; }
  /** Whether an agent started the run: every path a step uses, once expanded, must be on a local drive. */
  get agent() { return this.opts.env.agent === true; }
  /** Refuses an agent's path, as its tokens and captures expanded it, that is on a network share or a device. Call it before the text is resolved. */
  expanded(...texts: string[]) { requireNotRemote(this.agent, ...texts); }
  /** Refuses an agent's resolved path that is not a local drive-letter path, or is in Clop's recovery folders. Call it before the path is looked up or written. */
  local(...files: string[]) { for (const file of files) { requireLocalDrive(this.agent, file, this.opts.env.platform); this.opts.env.workdir.keepAgentOut(this.agent, file); } }
  get signal() { return this.opts.signal; }
  marker() { return this.opts.env.marker ?? defaultMarker(); }
  mark(file: string) { return this.marker().markOptimised(file).catch(() => {}); }

  /** A new empty folder for one step's output, inside the run's own folder in the work directory's temp. */
  async scratch(): Promise<string> {
    if (!this.root) {
      const temp = this.opts.env.workdir.temp;
      await mkdir(temp, { recursive: true });
      this.root = await mkdtemp(path.join(temp, 'pipeline-'));
      this.unprotect = this.opts.env.workdir.protect(this.root);
    }
    const dir = path.join(this.root, `step-${++this.scratchCount}`);
    await mkdir(dir);
    return dir;
  }

  /**
   * `TemplateContext.resolve`: surrounding quotes dropped, the `%` tokens of the source file (not the extension), the
   * `$1`… captures, then `~` and `$HOME`. Inline script code is never resolved.
   */
  resolve(template: string): string {
    let result = template.length >= 2 && template.startsWith('"') && template.endsWith('"') ? template.slice(1, -1) : template;
    const { counter, home, platform } = this.opts.env;
    if (result.includes('%')) result = expandTemplate(result, { path: this.original, counter, home, platform }, { safe: false, extension: false });
    // Highest first, so `$1` never eats the start of `$10`.
    for (let i = this.captures.length; i > 0; i--) result = result.replaceAll(`$${i}`, this.captures[i - 1]);
    return resolveHome(result, home, platform);
  }

  /** Removes the run's step folders, except those holding a file the run hands back. */
  async cleanup() {
    this.unprotect?.();
    if (!this.root) return;
    const keep = [this.current, ...this.forks, ...this.pages].map(file => path.resolve(file));
    const holds = (dir: string) => keep.some(file => file.startsWith(dir + path.sep));
    for (const name of await readdir(this.root).catch(() => [])) {
      const dir = path.join(this.root, name);
      if (!holds(dir)) await rm(dir, { recursive: true, force: true });
    }
    if (!holds(this.root)) await rm(this.root, { recursive: true, force: true });
  }
}
