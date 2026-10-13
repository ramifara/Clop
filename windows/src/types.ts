import type { ClopSettings } from '../core/settings/schema';
import type { MediaKind } from '../core/media/types';
export type OutputFormat = 'auto' | 'png' | 'jpeg' | 'webp' | 'avif' | 'gif';
export interface ImageOptions { mode: 'balanced' | 'aggressive' | 'lossless'; scale: number; maxEdge?: number; format: OutputFormat }
/**
 * A result card's item. Video, PDF and audio items have no pixel size of their own (0 for PDF and audio), keep their
 * original's preview and report `durationMs` or `pages`; `options` only matters for images. `progress` runs 0 to 1 while processing, when known.
 * A `folder` result is a file from a watched folder, optimised where it is.
 */
export interface ItemResult {
  id: string; kind: MediaKind; name: string; source: 'clipboard' | 'drop' | 'file' | 'folder' | 'sample'; status: 'processing' | 'ready' | 'error';
  originalBytes: number; outputBytes: number; originalWidth: number; originalHeight: number;
  width: number; height: number; format: string; originalPreview: string; preview: string;
  options: ImageOptions; error?: string; unchanged?: boolean; restored?: boolean; animated: boolean; createdAt: number;
  durationMs?: number; pages?: number; progress?: number;
  /** What attached or chosen pipelines reported: warnings, and pipelines that failed. */
  notes?: string[];
}
/** A saved pipeline the card's "Run pipeline…" menu offers. */
export interface PipelineChoice { id: string; name: string; text: string }
export type { ClopSettings };
/** An app the ignored-apps picker offers: a running app with a window, or a Start Menu app. `path` is an exe path, or an AUMID for a packaged app. */
export interface AppEntry { name: string; path: string; running: boolean }
export interface AppState { items: ItemResult[]; settings: ClopSettings; native: boolean; platform: string; dropActive?: boolean; notice?: string }
export interface ClopApi {
  state(): Promise<AppState>; subscribe(callback: (state: AppState) => void): () => void;
  importFiles(files: File[], aggressive?: boolean): Promise<void>; importUrl(url: string, aggressive?: boolean): Promise<void>; clipboard(): Promise<void>;
  apply(id: string, options: ImageOptions): Promise<void>; restore(id: string): Promise<void>;
  copy(id: string): Promise<void>; save(id: string): Promise<void>; reveal(id: string): Promise<void>;
  drag(id: string): void; dismiss(id: string): Promise<void>; settings(settings: Partial<ClopSettings>): Promise<void>;
  /** Apps for the ignored-apps picker; empty without the Windows helper. */
  apps(): Promise<AppEntry[]>;
  /** The saved pipelines the card can run on a result, and running one of them. */
  pipelines(id: string): Promise<PipelineChoice[]>; runPipeline(id: string, pipelineId: string): Promise<void>;
  window(action: 'hide' | 'main' | 'float' | 'quit' | 'minimize' | 'interactive' | 'passthrough' | 'dismiss-notice'): Promise<void>;
  mcp(request: McpRequest): Promise<McpState>;
}
declare global { interface Window { clop?: ClopApi } }
/** One agent in the MCP pane: whether Clop's server is in its config, and the line under its name. */
export interface McpClientRow { id: string; name: string; featured: boolean; state: 'installed' | 'notInstalled' | 'unusable'; detail: string; failed: boolean }
/** The MCP pane: the agents, and the server command for installing by hand, or why there is none. */
export interface McpState { clients: McpClientRow[]; server?: string; command?: string; missing?: string }
/** What the MCP pane asks the main process for. Clients are named by id; the main process owns every path. */
export type McpRequest = { action: 'state' } | { action: 'install' | 'remove' | 'reveal'; id: string } | { action: 'enable' | 'scripts'; on: boolean } | { action: 'copy'; what: 'command' | 'server' };
