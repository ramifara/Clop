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
  /** Nothing was saved because the entry changed elsewhere since the window showed it; `state` has the current one. */
  conflict?: boolean;
  saved?: string;
  removed?: { attachments: number; zones: number };
}
export interface EditorHost {
  /**
   * Runs `change` on the settings as they are when its turn comes, after every other write, and saves the values it returns
   * (`SettingsStore.update`). The command's read and write are one step, so another writer cannot slip in between.
   */
  update: <T>(change: (settings: ClopSettings) => { patch?: Partial<EditorSettings>; result: T }) => Promise<{ settings: ClopSettings; result: T }>;
  settings: () => ClopSettings;
  context: () => EditorContext;
}

export class EditorService {
  constructor(private readonly host: EditorHost) {}

  state(): EditorState { return editorState(this.host.settings(), this.host.context()); }

  /** Rejects with an Error for a malformed command or a failed save; a problem in what the user wrote is in the reply's `issues`. */
  async command(value: unknown): Promise<EditorReply> {
    const context = this.host.context();
    const { settings, result } = await this.host.update(current => {
      const done = applyCommand(current, value, context);
      return { ...(Object.keys(done.patch).length ? { patch: done.patch } : {}), result: done };
    });
    const { issues, conflict, saved, removed } = result;
    return { state: editorState(settings, context), ...(issues ? { issues } : {}), ...(conflict ? { conflict } : {}), ...(saved ? { saved } : {}), ...(removed ? { removed } : {}) };
  }
}
