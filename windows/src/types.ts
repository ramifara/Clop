import type { ClopSettings, CropSize } from '../core/settings/schema';
import type { MediaKind } from '../core/media/types';
import type { EditorCommand } from '../core/pipeline/editor-commands';
import type { EditorState } from '../core/pipeline/editor-state';
import type { PipelineIssue } from '../core/pipeline/parser';
import type { PresetTile } from '../core/pipeline/zones';
import type { EditorReply } from '../electron/editor';
import type { SettingMeta } from '../core/settings/controls';
import type { MediaName } from '../core/settings/entries';
import type { SettingKey } from '../core/settings/schema';
import type { SettingsTab } from '../core/settings/tabs';
import type { Invocation } from '../core/cards/actions';
export type OutputFormat = 'auto' | 'png' | 'jpeg' | 'webp' | 'avif' | 'gif' | 'heic' | 'jxl';
/** `crop` is the crop window's crop size, applied to the original before the scale and longest edge (images and videos). */
export interface ImageOptions {
  mode: 'balanced' | 'aggressive' | 'lossless'; scale: number; maxEdge?: number; format: OutputFormat; crop?: CropSize;
  /** A compression picked from the card's menu (adaptive, or a factor of 5–100), which wins over `mode`. */
  compression?: { tier: 'adaptive' | 'custom'; factor: number };
}
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
  /** Counts the changes to the result's file, so a window showing it can tell a new one from the one it has. */
  revision?: number;
  /** What attached or chosen pipelines reported: warnings, and pipelines that failed. */
  notes?: string[];
}
/** A saved pipeline the card's "Run pipeline…" menu offers. */
export interface PipelineChoice { id: string; name: string; text: string; /** Set when the pipeline works on one kind of file only. */ fileType?: MediaKind }
export type { ClopSettings, CropSize };
/** A region relative to the displayed image, frame or page: 0–1 with a top-left origin. */
export type CropRect = NonNullable<CropSize['cropRect']>;
export type CropOrientation = 'portrait' | 'landscape' | 'adaptive';
/**
 * What the crop window applies. Images and videos are cut to a crop size from their original; PDFs change the page boxes of the
 * current result: a region, an aspect ratio (cropping, or extending the page with empty paper), or back to the whole page.
 */
export type CropRequest = { type: 'size'; size: CropSize } | { type: 'pdf-rect'; rect: CropRect }
  | { type: 'pdf-aspect'; aspectRatio: number; orientation: CropOrientation; extend: boolean; rect?: CropRect } | { type: 'pdf-uncrop' };
/**
 * The picture the crop window crops on: the original image, a video frame or a whole PDF page of the result. `width` × `height`
 * is the source's displayed size in pixels (points for a PDF); a PDF also says its page, page count, current crop box and, when
 * any page is cropped, the page's uncropped size.
 */
export interface CropSource { item: ItemResult; preview: string; width: number; height: number; page?: number; pages?: number; initialRect?: CropRect; uncropped?: { width: number; height: number } }
/** One side of the compare window: a URL the window may load, with what the labels show. */
export interface CompareSide { url: string; kind: MediaKind; format: string; bytes: number; width?: number; height?: number; durationMs?: number; bitrate?: number }
/** The original and the current result; PDFs are compared a rendered page at a time. */
export interface CompareSources { item: ItemResult; original: CompareSide; result: CompareSide; page?: number; pages?: number }
/** An app the ignored-apps picker offers: a running app with a window, or a Start Menu app. `path` is an exe path, or an AUMID for a packaged app. */
export interface AppEntry { name: string; path: string; running: boolean }
/** The preset zone tiles for the drag in progress. They show while `revealed` (Ctrl or Alt held); `add` is the "new preset" tile after them. */
export interface PresetTiles { revealed: boolean; tiles: PresetTile[]; add: boolean }
/** Where the Settings window was last asked to open (a tray item or `clop://settings/…` link); `nonce` changes with each request so the same target can be asked for again. */
export interface SettingsRequest { tab: SettingsTab; row?: string; nonce: number }
export type { EditorCommand, EditorReply, EditorState, PipelineIssue, PresetTile };
/** `compact` is the results layout showing (the list, or full cards) and `cards` how many full cards fit. */
export interface AppState {
  items: ItemResult[]; settings: ClopSettings; native: boolean; platform: string; dropActive?: boolean; notice?: string; presets?: PresetTiles; settingsRequest?: SettingsRequest;
  layout?: { compact: boolean; cards: number };
  /** Every saved pipeline a card button or menu can run, for the buttons set to run one. */
  pipelines?: PipelineChoice[];
  /** The first-run card is showing: set until the user dismisses it (`finishedOnboarding`). */
  welcome?: true;
}
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
  mcp(request: McpRequest): Promise<McpState>;
  window(action: 'hide' | 'close' | 'main' | 'float' | 'quit' | 'minimize' | 'interactive' | 'passthrough' | 'dismiss-notice' | 'finish-welcome' | 'editor' | 'presets' | 'select' | 'unselect'): Promise<void>;
  /** Opens (or brings forward) a result's crop, compare or preview window. */
  openCrop(id: string): Promise<void>; openCompare(id: string): Promise<void>; openPreview(id: string): Promise<void>;
  /** Pops up the right-click menu of results (the batch menu for several), or one of its submenus by name, at the pointer. */
  cardMenu(ids: string[], menu?: string): Promise<void>;
  /** Runs a menu or button action on results; the main process checks it against the card action table. */
  cardAction(ids: string[], invocation: Invocation): Promise<void>;
  /** The crop window's picture; `page` is 1-based (PDF), `time` a fraction of the video's duration. */
  cropSource(id: string, view?: { page?: number; time?: number }): Promise<CropSource>;
  crop(id: string, request: CropRequest): Promise<void>;
  /** The `savedCropSizes` setting, and the only way the renderer can change it. */
  cropSizes(): Promise<CropSize[]>; saveCropSizes(sizes: CropSize[]): Promise<CropSize[]>;
  compareSources(id: string, view?: { page?: number }): Promise<CompareSources>;
  /** Drops on a preset zone's tile: the files are optimised, then the zone's pipeline runs on them. */
  runPreset(zoneId: string, files: File[]): Promise<void>;
  /** The pipeline editor window's side: what it shows, and the checked commands that change pipelines, attachments and preset zones. */
  editor: {
    state(): Promise<EditorState>; command(command: EditorCommand): Promise<EditorReply>;
    /** Hears that pipelines, attachments or preset zones changed elsewhere, or that the window was asked to open on the preset zones. */
    subscribe(callback: (event: 'changed' | 'zones') => void): () => void;
  };
  /** The Settings window's actions that need the main process: pickers, validated list edits, previews. */
  prefs(request: PrefsRequest): Promise<PrefsReply>;
}
declare global { interface Window { clop?: ClopApi } }
/** One agent in the MCP pane: whether Clop's server is in its config, and the line under its name. */
export interface McpClientRow { id: string; name: string; featured: boolean; state: 'installed' | 'notInstalled' | 'unusable'; detail: string; failed: boolean }
/** The MCP pane: the agents, and the server command for installing by hand, or why there is none. */
export interface McpState { clients: McpClientRow[]; server?: string; command?: string; missing?: string }
/** What the MCP pane asks the main process for. Clients are named by id; the main process owns every path. */
export type McpRequest = { action: 'state' } | { action: 'install' | 'remove' | 'reveal'; id: string } | { action: 'enable' | 'scripts'; on: boolean } | { action: 'copy'; what: 'command' | 'server' };
/** The settings that open a file or folder picker, or whose value the main process checks before it is saved; the window never writes these through `settings`. */
export type PrefsRequest =
  | { action: 'meta' }
  /** What a name or path template makes of an example file. `key` is one of the template settings. */
  | { action: 'template'; key: SettingKey; template: string }
  | { action: 'workdir'; op: 'choose' | 'reset' }
  | { action: 'folder'; kind: MediaName; op: 'add' | 'remove'; folder?: string }
  | { action: 'quiet'; folder: string; quiet: boolean }
  | { action: 'editor'; kind: MediaName; op: 'choose' | 'clear' }
  | { action: 'ignore'; op: 'add' | 'remove' | 'choose'; entry?: string }
  /** Opens the pipeline editor window, on its preset zones when `tab` is `zones`. */
  | { action: 'pipeline-editor'; tab?: 'zones' }
  | { action: 'open'; target: 'releases' | 'source' | 'upstream' | 'issues' }
  | { action: 'version' }
  /** Looks for a new version now (a dialog offers one), and saves the debug dump and shows it in Explorer. */
  | { action: 'check-updates' }
  | { action: 'debug-dump' };
export interface PrefsReply {
  /** Said to the user: what changed, or why nothing did. */
  message?: string;
  meta?: SettingMeta[];
  preview?: { input: string; output: string };
  version?: { name: string; platform: string };
}
