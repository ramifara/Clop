import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FileBehaviour, PlacementOverride } from '../placement';
import { COMPRESSION_TIERS, type CompressionQuality, type CropSize } from '../settings/schema';

// What the CLI, the MCP server and the app say to each other. The request and response shapes are the macOS Codable
// types (Shared.swift `OptimisationRequest`, `OptimisationResponse`, `SettingsRequest`…) encoded the way Swift's
// JSONEncoder writes them: nil optionals left out, URLs as absolute URL strings, sizes as `[width, height]`.
// The transport is one named pipe (a Unix socket off Windows), newline-delimited JSON, one connection per request:
// after the `hello` handshake below, the client writes one `ClientMessage` line, and the app answers with
// `ServerMessage` lines and closes the connection.
// macOS answers per-file results on a reply port the CLI names; here they come back on the request's own connection.

export type { FileBehaviour, PlacementOverride, CompressionQuality, CropSize };
export type Size = [width: number, height: number];

export interface OptimisationRequest {
  id: string;
  /** Absolute URL strings: `file:` URLs for files and folders' contents, `http:`/`https:` for downloads. */
  urls: string[];
  /** `[tempURL: originalURL]`, which Swift encodes as an array alternating key and value. Unused on Windows. */
  originalUrls?: string[];
  size?: CropSize;
  downscaleFactor?: number;
  changePlaybackSpeedFactor?: number;
  hideFloatingResult: boolean;
  copyToClipboard: boolean;
  aggressiveOptimisation: boolean;
  adaptiveOptimisation?: boolean;
  source: string;
  output?: string;
  removeAudio?: boolean;
  /** PDF DPI override: 0 is adaptive, otherwise one of the DPI stops. */
  pdfDPI?: number;
  compression?: CompressionQuality;
  audioBitrate?: number;
  /** A saved pipeline's name or id, or inline pipeline text. */
  pipeline?: string;
  prepareInBatch?: boolean;
  placement?: PlacementOverride;
  /** `mcp` when the request came through the MCP server; the app applies the MCP gate to it. */
  origin?: string;
  /** macOS names the CLI's reply port here. Accepted and ignored: results come back on the connection. */
  replyPort?: string;
  /** `keep` or `drop`. */
  changePlaybackSpeedFrames?: 'keep' | 'drop';
}

export interface OptimisationResponse {
  path: string;
  forURL: string;
  convertedFrom?: string;
  oldBytes: number;
  newBytes: number;
  oldWidthHeight?: Size;
  newWidthHeight?: Size;
  oldBitrate?: number;
  newBitrate?: number;
  oldDPI?: number;
  newDPI?: number;
}
export interface OptimisationResponseError { error: string; forURL: string }
export interface StopOptimisationRequest { ids: string[]; remove: boolean }
/** `--json` output of the file commands. */
export interface CLIResult { done: OptimisationResponse[]; failed: OptimisationResponseError[] }

/**
 * `schema`, `get`, `set` and `gate` are the macOS actions. Windows adds `read` (every setting as stored, for the
 * pipeline library commands) and `update` (several stored values at once): macOS writes those straight into its defaults
 * suite, but here the running app owns the settings file and would overwrite a write it did not make.
 */
export const SETTINGS_ACTIONS = ['schema', 'get', 'set', 'gate', 'read', 'update'] as const;
export interface SettingsRequest {
  action: (typeof SETTINGS_ACTIONS)[number];
  key?: string;
  value?: string;
  query?: string;
  origin?: string;
  /** Pipeline text a `gate` or `update` is about to save or attach, so script steps are refused for agents. */
  pipeline?: string;
  /** `update` only: stored values by key, in the settings file's shape. */
  values?: Record<string, unknown>;
  /**
   * `update` only: the values these keys had when the client read them. The change is refused, with `SETTINGS_CHANGED`, when
   * any of them is different by the time its turn comes, so a pipeline edit built on a stale read never overwrites what the
   * editor or another command saved in between.
   */
  base?: Record<string, unknown>;
}
/** What an `update` with a stale `base` is answered with. */
export const SETTINGS_CHANGED = 'Clop\'s pipelines or settings changed while this change was being prepared, so it was not saved. Run it again.';
export interface MCPSettingInfo { key: string; type: string; value: string; allowed?: string[]; title: string; subtitle: string; keywords: string[]; pane: string; section: string; entryID: string }
export interface SettingsResponse { ok: boolean; error?: string; settings?: MCPSettingInfo[]; values?: Record<string, unknown> }

export type ClientMessage =
  | { kind: 'optimise'; request: OptimisationRequest }
  | { kind: 'stop'; request: StopOptimisationRequest }
  | { kind: 'settings'; request: SettingsRequest };
export type ServerMessage =
  /** `ProgressPayload` for one input. */
  | { kind: 'progress'; forURL: string; fractionCompleted: number }
  | { kind: 'response'; response: OptimisationResponse }
  | { kind: 'error'; error: OptimisationResponseError }
  /** Every input of an optimise request has answered. */
  | { kind: 'done' }
  | { kind: 'settings'; response: SettingsResponse }
  /** The request as a whole could not be handled (malformed, or refused before any file was touched). */
  | { kind: 'failed'; error: string };

/** One message is at most this long; the server drops a connection that sends more without a newline. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_URLS = 100_000;

// Validation. Every field is checked for type, unknown fields are dropped, and the first problem is reported.

class ProtocolError extends Error { override name = 'ProtocolError'; }
const fail = (message: string): never => { throw new ProtocolError(message); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const record = (value: unknown, what: string) => isRecord(value) ? value : fail(`${what} must be an object.`);
const str = (value: unknown, what: string, max = 32_768) => typeof value === 'string' && value.length <= max ? value : fail(`${what} must be a string.`);
const bool = (value: unknown, what: string) => typeof value === 'boolean' ? value : fail(`${what} must be true or false.`);
const num = (value: unknown, what: string) => typeof value === 'number' && Number.isFinite(value) ? value : fail(`${what} must be a number.`);
const int = (value: unknown, what: string) => Number.isInteger(value) ? value as number : fail(`${what} must be a whole number.`);
const optional = <T>(value: unknown, parse: (value: unknown) => T): T | undefined => value === undefined || value === null ? undefined : parse(value);
const oneOf = <T extends string>(values: readonly T[], value: unknown, what: string) => values.includes(value as T) ? value as T : fail(`${what} must be one of ${values.join(', ')}.`);
/** Drops undefined values, as Swift leaves nil optionals out. */
export const compact = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

const FILE_BEHAVIOURS: readonly FileBehaviour[] = ['temporary', 'inPlace', 'sameFolder', 'specificFolder'];

/** A `file:`, `http:` or `https:` URL string. */
export function inputURL(value: unknown, what = 'A URL'): string {
  const text = str(value, what);
  let url: URL;
  try { url = new URL(text); } catch { return fail(`${what} is not a URL: ${text.slice(0, 200)}`); }
  if (!['file:', 'http:', 'https:'].includes(url.protocol)) fail(`${what} must be a file, http or https URL.`);
  return text;
}

function cropSize(value: unknown): CropSize {
  const v = record(value, 'size');
  const rect = optional(v.cropRect, r => { const c = record(r, 'size.cropRect'); return { x: num(c.x, 'cropRect.x'), y: num(c.y, 'cropRect.y'), width: num(c.width, 'cropRect.width'), height: num(c.height, 'cropRect.height') }; });
  const size = compact({
    width: int(v.width, 'size.width'), height: int(v.height, 'size.height'), name: optional(v.name, x => str(x, 'size.name')) ?? '',
    longEdge: optional(v.longEdge, x => bool(x, 'size.longEdge')) ?? false, smartCrop: optional(v.smartCrop, x => bool(x, 'size.smartCrop')) ?? false,
    isAspectRatio: optional(v.isAspectRatio, x => bool(x, 'size.isAspectRatio')), cropRect: rect,
  });
  if (size.width < 0 || size.height < 0 || size.width > 100_000 || size.height > 100_000) fail('size must be between 0 and 100000 pixels.');
  return size;
}

function compression(value: unknown): CompressionQuality {
  const v = record(value, 'compression');
  const factor = int(v.factor, 'compression.factor');
  if (factor < 0 || factor > 100) fail('compression.factor must be between 0 and 100.');
  return { tier: oneOf(COMPRESSION_TIERS, v.tier, 'compression.tier'), factor };
}

function placement(value: unknown): PlacementOverride {
  const v = record(value, 'placement'), behaviour = (x: unknown) => oneOf(FILE_BEHAVIOURS, x, 'A placement behaviour');
  return compact({
    optimised: optional(v.optimised, behaviour), autoConvert: optional(v.autoConvert, behaviour), manualConvert: optional(v.manualConvert, behaviour),
    sameFolderTemplate: optional(v.sameFolderTemplate, x => str(x, 'placement.sameFolderTemplate')), specificFolderTemplate: optional(v.specificFolderTemplate, x => str(x, 'placement.specificFolderTemplate')),
  });
}

const positive = (value: unknown, what: string) => { const n = num(value, what); return n > 0 ? n : fail(`${what} must be greater than 0.`); };

export function parseOptimisationRequest(value: unknown): OptimisationRequest {
  const v = record(value, 'The request');
  if (!Array.isArray(v.urls) || v.urls.length > MAX_URLS) fail('urls must be a list of URLs.');
  const request: OptimisationRequest = compact({
    id: str(v.id, 'id', 256), urls: (v.urls as unknown[]).map(url => inputURL(url)),
    originalUrls: optional(v.originalUrls, x => Array.isArray(x) ? x.map(url => inputURL(url)) : fail('originalUrls must be a list.')),
    size: optional(v.size, cropSize), downscaleFactor: optional(v.downscaleFactor, x => positive(x, 'downscaleFactor')),
    changePlaybackSpeedFactor: optional(v.changePlaybackSpeedFactor, x => positive(x, 'changePlaybackSpeedFactor')),
    hideFloatingResult: bool(v.hideFloatingResult, 'hideFloatingResult'), copyToClipboard: bool(v.copyToClipboard, 'copyToClipboard'),
    aggressiveOptimisation: bool(v.aggressiveOptimisation, 'aggressiveOptimisation'), adaptiveOptimisation: optional(v.adaptiveOptimisation, x => bool(x, 'adaptiveOptimisation')),
    source: str(v.source, 'source', 256), output: optional(v.output, x => str(x, 'output')), removeAudio: optional(v.removeAudio, x => bool(x, 'removeAudio')),
    pdfDPI: optional(v.pdfDPI, x => { const dpi = int(x, 'pdfDPI'); return dpi >= 0 && dpi <= 1200 ? dpi : fail('pdfDPI must be 0 (adaptive) or a DPI.'); }),
    compression: optional(v.compression, compression), audioBitrate: optional(v.audioBitrate, x => { const kbps = int(x, 'audioBitrate'); return kbps > 0 ? kbps : fail('audioBitrate must be greater than 0.'); }),
    pipeline: optional(v.pipeline, x => str(x, 'pipeline')), prepareInBatch: optional(v.prepareInBatch, x => bool(x, 'prepareInBatch')),
    placement: optional(v.placement, placement), origin: optional(v.origin, x => str(x, 'origin', 64)), replyPort: optional(v.replyPort, x => str(x, 'replyPort', 512)),
    changePlaybackSpeedFrames: optional(v.changePlaybackSpeedFrames, x => oneOf(['keep', 'drop'] as const, x, 'changePlaybackSpeedFrames')),
  });
  if (request.placement && !Object.keys(request.placement).length) delete request.placement;
  return request;
}

export function parseStopRequest(value: unknown): StopOptimisationRequest {
  const v = record(value, 'The request');
  if (!Array.isArray(v.ids) || v.ids.length > MAX_URLS) fail('ids must be a list.');
  return { ids: (v.ids as unknown[]).map(id => str(id, 'An id')), remove: bool(v.remove, 'remove') };
}

export function parseSettingsRequest(value: unknown): SettingsRequest {
  const v = record(value, 'The request');
  return compact({
    action: oneOf(SETTINGS_ACTIONS, v.action, 'action'), key: optional(v.key, x => str(x, 'key', 256)), value: optional(v.value, x => str(x, 'value', MAX_MESSAGE_BYTES)),
    query: optional(v.query, x => str(x, 'query', 4096)), origin: optional(v.origin, x => str(x, 'origin', 64)), pipeline: optional(v.pipeline, x => str(x, 'pipeline', MAX_MESSAGE_BYTES)),
    values: optional(v.values, x => record(x, 'values')), base: optional(v.base, x => record(x, 'base')),
  });
}

/** Reads one client line. Throws a readable error for anything that is not a well-formed request. */
export function parseClientMessage(line: string): ClientMessage {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return fail('The request is not JSON.'); }
  const v = record(value, 'The message');
  switch (v.kind) {
    case 'optimise': return { kind: 'optimise', request: parseOptimisationRequest(v.request) };
    case 'stop': return { kind: 'stop', request: parseStopRequest(v.request) };
    case 'settings': return { kind: 'settings', request: parseSettingsRequest(v.request) };
    default: return fail('The message kind must be optimise, stop or settings.');
  }
}

function size(value: unknown, what: string): Size {
  return Array.isArray(value) && value.length === 2 ? [num(value[0], what), num(value[1], what)] : fail(`${what} must be [width, height].`);
}
function response(value: unknown): OptimisationResponse {
  const v = record(value, 'The response'), opt = (key: string) => optional(v[key], x => num(x, key));
  return compact({
    path: str(v.path, 'path'), forURL: str(v.forURL, 'forURL'), convertedFrom: optional(v.convertedFrom, x => str(x, 'convertedFrom')),
    oldBytes: num(v.oldBytes, 'oldBytes'), newBytes: num(v.newBytes, 'newBytes'),
    oldWidthHeight: optional(v.oldWidthHeight, x => size(x, 'oldWidthHeight')), newWidthHeight: optional(v.newWidthHeight, x => size(x, 'newWidthHeight')),
    oldBitrate: opt('oldBitrate'), newBitrate: opt('newBitrate'), oldDPI: opt('oldDPI'), newDPI: opt('newDPI'),
  });
}

/** Reads one server line, so a client never trusts a malformed answer. */
export function parseServerMessage(line: string): ServerMessage {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return fail('Clop sent an answer that is not JSON.'); }
  const v = record(value, 'The answer');
  switch (v.kind) {
    case 'progress': return { kind: 'progress', forURL: str(v.forURL, 'forURL'), fractionCompleted: num(v.fractionCompleted, 'fractionCompleted') };
    case 'response': return { kind: 'response', response: response(v.response) };
    case 'error': { const e = record(v.error, 'error'); return { kind: 'error', error: { error: str(e.error, 'error'), forURL: str(e.forURL, 'forURL') } }; }
    case 'done': return { kind: 'done' };
    case 'settings': {
      const r = record(v.response, 'response');
      return { kind: 'settings', response: compact({ ok: bool(r.ok, 'ok'), error: optional(r.error, x => str(x, 'error')), settings: optional(r.settings, x => Array.isArray(x) ? x as MCPSettingInfo[] : fail('settings must be a list.')), values: optional(r.values, x => record(x, 'values')) }) };
    }
    case 'failed': return { kind: 'failed', error: str(v.error, 'error') };
    default: return fail('Clop sent an answer of an unknown kind.');
  }
}

export const encodeMessage = (message: ClientMessage | ServerMessage) => `${JSON.stringify(message)}\n`;

/** Splits a UTF-8 byte stream into lines, refusing a line longer than `limit` bytes. Characters split across chunks are joined first. */
export class LineReader {
  private buffer = '';
  private bytes = 0;
  private readonly decoder = new StringDecoder('utf8');
  constructor(private readonly onLine: (line: string) => void, private readonly limit = MAX_MESSAGE_BYTES) {}
  push(chunk: Buffer | string) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.buffer += this.decoder.write(bytes);
    this.bytes += bytes.length;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.bytes = Buffer.byteLength(this.buffer);
      if (line.trim()) this.onLine(line);
    }
    if (this.bytes > this.limit) { this.buffer = ''; this.bytes = 0; throw new ProtocolError('The message is too long.'); }
  }
}

// URLs. Inputs travel as URL strings, as on macOS; a Windows path becomes `file:///C:/…`.

export const fileURL = (file: string) => pathToFileURL(path.resolve(file)).href;
/** The local path of a `file:` URL, or undefined for a download. */
export const urlPath = (url: string) => url.startsWith('file:') ? fileURLToPath(url) : undefined;

// Where the app listens. Each start picks a random pipe name and a random key and writes both to `ipc.json` in the
// user's app data folder, which only the user (and administrators) can read. Pipe names can be listed by anyone, so the
// name alone proves nothing: before sending a request, a client sends a nonce and the app answers with an HMAC of it
// under the key (`hello`). A pipe someone else created under a stale name cannot answer, and gets no request.

export interface PipeInfo { pipe: string; pid: number; key: string }
/** What a client needs to reach the app: the pipe and the key that proves the app is behind it. */
export interface PipeEndpoint { pipe: string; key: string }
export const pipeInfoFile = (userData: string) => path.join(userData, 'ipc.json');
export function newPipePath(platform: NodeJS.Platform = process.platform): string {
  const id = randomUUID().replaceAll('-', '');
  return platform === 'win32' ? `\\\\.\\pipe\\clop-${id}` : path.join(os.tmpdir(), `clop-${id.slice(0, 16)}.sock`);
}
export const newPipeKey = () => randomBytes(32).toString('base64');
/** The first line on every connection, from the client; the app answers with `{ hello: proof }` before reading the request. */
export interface Hello { hello: string }
export const helloProof = (key: string, nonce: string) => createHmac('sha256', Buffer.from(key, 'base64')).update(nonce).digest('base64');
/** Checks the app's answer to `nonce` in constant time. */
export function validProof(key: string, nonce: string, proof: unknown): boolean {
  if (typeof proof !== 'string') return false;
  const expected = Buffer.from(helloProof(key, nonce)), given = Buffer.from(proof);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
export function parseHello(line: string): string {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return fail('The greeting is not JSON.'); }
  const hello = record(value, 'The greeting').hello;
  return typeof hello === 'string' && hello.length >= 16 && hello.length <= 256 ? hello : fail('The connection must start with a greeting.');
}
