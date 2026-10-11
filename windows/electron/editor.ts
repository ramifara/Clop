import type { ClopSettings } from '../core/settings/schema';
import { applyCommand } from '../core/pipeline/editor-commands';
import { editorState, type EditorContext, type EditorSettings, type EditorState } from '../core/pipeline/editor-state';
import type { PipelineIssue } from '../core/pipeline/parser';

// The main process's side of the pipeline editor window (spec step 22). Commands from the window are checked and applied here,
// one at a time, each on top of the settings the one before saved; the window only ever gets back views to draw.

export interface EditorReply {
  state: EditorState;
  /** Problems with what the user wrote. Nothing was saved. */
  issues?: PipelineIssue[];
  saved?: string;
  removed?: { attachments: number; zones: number };
}
export interface EditorHost {
  settings: () => ClopSettings;
  /** Validates and saves a change to the settings. */
  change: (patch: Partial<EditorSettings>) => Promise<unknown>;
  context: () => EditorContext;
}

export class EditorService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly host: EditorHost) {}

  state(): EditorState { return editorState(this.host.settings(), this.host.context()); }

  /** Rejects with an Error for a malformed command or a failed save; a problem in what the user wrote is in the reply's `issues`. */
  command(value: unknown): Promise<EditorReply> {
    const job = this.queue.then(async (): Promise<EditorReply> => {
      const { patch, issues, saved, removed } = applyCommand(this.host.settings(), value, this.host.context());
      if (Object.keys(patch).length) await this.host.change(patch);
      return { state: this.state(), ...(issues ? { issues } : {}), ...(saved ? { saved } : {}), ...(removed ? { removed } : {}) };
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
