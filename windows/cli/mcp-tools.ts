import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, McpError, type ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import { samePath } from '../core/fileops';
import { VIDEO_EXTENSIONS } from '../core/media/detect';
import { resolveHome } from '../core/template';
import { backendOptions, type BackendOptions } from './backend';
import { main } from './main';
import { CANCELLED_PREFIX, DECLINED_PREFIX, FACTOR_OPTIONS_TEXT, FACTOR_SCHEMA, framesOptionsText, framesSchema, SMALLER_OPTIONS_TEXT, SMALLER_SCHEMA } from './mcp-copy';
import { sortedJSON } from './results';

// What `clop mcp serve` can do (ClopCLI/MCPTools.swift and the handlers in MCPToolTable.swift): every tool runs a `clop`
// command in this process with its output captured, so it reaches the app over the pipe, or runs headless, the way the
// CLI does, and every request carries origin `mcp`, which the app's gate reads.

/** A message for the agent to read. Clop's own refusals come back verbatim, with only the next step added. */
export class ClopMCPError extends Error {}
/** Prose stays readable as text; `json` is for payloads an agent should parse. */
export type ToolOutput = { text: string } | { json: unknown };
export type Args = Record<string, unknown>;

export interface MCPOptions {
  /** The environment commands run with. */
  env?: NodeJS.ProcessEnv;
  /** Where the app keeps its settings and publishes its pipe. */
  options?: BackendOptions;
  cwd?: string;
  home?: string;
  /** Opens a `clop://` link. By default it goes to the app the server card names, launching it. */
  openURL?: (url: string) => Promise<void>;
  /** How long a person gets to answer a question. `CLOP_MCP_ELICIT_TIMEOUT` seconds, else 120 s. */
  elicitTimeoutMs?: number;
  /** The executables the server card may name as the app: this process's own, and the portable app's launcher. */
  appExecutables?: string[];
  /** How long clop_start_server waits for the user to allow agents. */
  startWaitMs?: number;
  /** Where the commands' own stderr goes: the client's log, by default. */
  log?: (text: string) => void;
}

/** One tool call: its arguments, the client's cancellation, and the server for questions to the user. */
export interface Call { name: string; args: Args; signal?: AbortSignal; server: Server; options: MCPOptions }
export type Handler = (args: Args, call: Call) => Promise<ToolOutput>;

const log = (text: string) => process.stderr.write(`[clop-mcp] ${text}\n`);
/** A pipeline over a folder of videos is minutes of ffmpeg, so file work gets its own deadline. */
const FILE_TIMEOUT = 900;

// MARK: Running a command

/** One `clop` command in this process, its stdout and stderr captured. Its stderr still reaches the client's log. */
async function runCommand(call: Call, args: string[], timeoutSeconds: number) {
  const out: string[] = [], err: string[] = [];
  let message = '';
  const controller = new AbortController(), abort = () => controller.abort();
  // The file commands wait for each file. Without a deadline one stuck ffmpeg would hold the call open for good.
  const timer = setTimeout(abort, timeoutSeconds * 1000);
  call.signal?.addEventListener('abort', abort, { once: true });
  const env = call.options.env ?? process.env;
  try {
    const code = await main(args, {
      io: { out: text => { out.push(text); }, err: text => { err.push(text); }, errTTY: false }, colours: false,
      // Set here rather than left to the environment, so nothing can drop the stamp the app's gate reads.
      env: { ...env, CLOP_ORIGIN: 'mcp' }, options: call.options.options ?? backendOptions(env), cwd: call.options.cwd, home: call.options.home,
      signal: controller.signal, onError: error => { message = error instanceof Error ? error.message : String(error); },
    });
    const stderr = err.join('');
    if (stderr) (call.options.log ?? (text => process.stderr.write(text)))(stderr);
    return { out: out.join('').trim(), err: stderr.trim(), code, message };
  } finally { clearTimeout(timer); call.signal?.removeEventListener('abort', abort); }
}

/** `--json` has to come before the `--` that ends the options, or the CLI would read it as a file. */
function withJSON(args: string[]) {
  const end = args.indexOf('--');
  return end < 0 ? [...args, '--json'] : [...args.slice(0, end), '--json', ...args.slice(end)];
}

/** Runs a command with `--json` and reads what it prints. Per-file failures carry the next step, and nothing done is an error. */
export async function run(call: Call, args: string[], timeout = 30): Promise<ToolOutput> {
  const result = await runCommand(call, withJSON(args), timeout);
  const complaint = result.message || result.err;
  if (!result.out) throw new ClopMCPError(annotate(complaint || `Clop exited ${result.code} with no output`));
  let parsed: unknown;
  try { parsed = JSON.parse(result.out); } catch {
    if (result.code !== 0) throw new ClopMCPError(annotate(complaint || result.out));
    return { text: result.out };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { json: prune(parsed) };
  const object = parsed as Record<string, unknown>;
  if (object.ok === false) throw new ClopMCPError(annotate(typeof object.error === 'string' ? object.error : complaint || 'Clop refused the request'));
  const failed = object.failed;
  if (Array.isArray(failed) && failed.length) {
    object.failed = failed.map(entry => entry && typeof entry.error === 'string' ? { ...entry, error: annotate(entry.error) } : entry);
    if (!Array.isArray(object.done) || !object.done.length) {
      const errors = (object.failed as { error?: unknown }[]).map(entry => entry?.error).filter((error): error is string => typeof error === 'string');
      throw new ClopMCPError(errors.length ? errors.join('; ') : 'Clop could not process any of the files');
    }
  }
  return { json: prune(object) };
}

/** Runs a command whose output is prose (pipeline prompt, strip-exif). */
export async function text(call: Call, args: string[], timeout = 30): Promise<ToolOutput> {
  const result = await runCommand(call, args, timeout);
  if (result.code !== 0) {
    const complaint = result.message || result.err || result.out;
    throw new ClopMCPError(annotate(complaint || `Clop exited ${result.code}`));
  }
  return { text: result.out || 'Done.' };
}

/** Clop's refusals come back verbatim with the next step, which is always "ask the user". Clop for Windows has no Pro licence. */
export function annotate(message: string): string {
  const low = message.toLowerCase();
  // A message that already tells the agent to ask the user needs no second telling.
  if (low.includes('ask the user')) return message;
  if (low.includes('script') && low.includes('allow')) {
    return `${message} Script steps are behind their own switch. Ask the user to allow them in Clop Settings, MCP. Prefer a built-in step: it is faster, the editor understands it, and it survives a Clop update.`;
  }
  if (low.includes('not accepting changes') || low.includes('agents')) {
    return `${message} Ask the user to allow agent changes in Clop Settings, MCP, or call clop_start_server, which puts that question on screen for them.`;
  }
  return message;
}

/** Drops nulls, so a result reads. */
export function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, prune(item)]));
  return value;
}

export const pretty = (value: unknown) => sortedJSON(value);

// MARK: Argument helpers

/** A JSON value as one command-line argument. */
export function argument(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return String(value ?? '');
}
/** An option and its value as one `--name=value` argument, so a value that starts with a dash is still only a value. */
const opt = (a: Args, flag: string, key: string) => { const value = a[key]; if (value === undefined || value === null) return []; const s = argument(value); return s ? [`${flag}=${s}`] : []; };
const given = (flag: string, value: string) => [`${flag}=${value}`];
/**
 * A command line from an agent's request: the command words, its options, then everything the agent wrote as data after
 * `--`. Nothing an agent sends can be read as a flag, whatever it looks like (`-h`, `--output=/x`, `--async`).
 */
export const command = (words: string[], options: string[] = [], positionals: string[] = []) => [...words, ...options, ...(positionals.length ? ['--', ...positionals] : [])];
const flag = (a: Args, key: string, name: string) => a[key] === true ? [name] : [];
const isURL = (item: string) => /^(https?|file):\/\//i.test(item);

/** The files a tool works on: `~` expanded, otherwise as the agent wrote them, since results are keyed by the input. */
export function paths(a: Args, call: Call, key = 'paths'): string[] {
  const raw = Array.isArray(a[key]) ? a[key] as unknown[] : a[key] === undefined ? [] : [a[key]];
  const list = raw.map(argument).filter(item => item.trim()).map(item => isURL(item) ? item : resolveHome(item, call.options.home));
  if (!list.length) throw new ClopMCPError('no files given: pass one or more paths, folders or URLs');
  return list;
}

export function subject(list: string[]) {
  const trimmed = list[0].replace(/[\\/]+$/, ''), first = path.basename(trimmed) || list[0];
  return list.length === 1 ? first : `${first} and ${list.length - 1} more`;
}

/** The flags every file command shares. Progress bars are for a terminal, and this stream is a protocol. */
const commonFlags = (a: Args) => [...flag(a, 'recursive', '--recursive'), ...flag(a, 'copy', '--copy'), ...flag(a, 'aggressive', '--aggressive'), ...flag(a, 'skipErrors', '--skip-errors'), ...opt(a, '--output', 'output'), ...opt(a, '--types', 'types'), ...opt(a, '--behaviour', 'behaviour'), '--no-progress'];

const exists = (file: string) => { try { return statSync(file); } catch { return undefined; } };
/** A path the agent gave, as the command will read it. */
const local = (call: Call, file: string) => path.resolve(call.options.cwd ?? process.cwd(), file);

// MARK: The switch

function userData(call: Call) { return (call.options.options ?? backendOptions(call.options.env ?? process.env)).userData; }
/** The server card the app writes on every launch. A hint, never a requirement. */
function card(call: Call): Record<string, unknown> {
  try { const value = JSON.parse(readFileSync(path.join(userData(call), 'mcp.json'), 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

/**
 * The app the server card names, when it is the app this server belongs to. The card is a file in the user's data folder,
 * so a path in it is only a hint: running whatever it names would let anything that can write there start a program.
 */
function cardApp(call: Call): string | undefined {
  const app = (card(call).app as { path?: unknown } | undefined)?.path;
  if (typeof app !== 'string' || !/\.exe$/i.test(app) || !exists(app)?.isFile()) return undefined;
  const env = call.options.env ?? process.env;
  const known = call.options.appExecutables ?? [process.execPath, env.PORTABLE_EXECUTABLE_FILE ?? ''].filter(Boolean);
  return known.some(file => samePath(app, file)) ? app : undefined;
}

/** Hands `clop://mcp/<action>` to the app the card names, launching it when it is not running. */
async function openControlURL(call: Call, action: 'start' | 'stop') {
  const url = `clop://mcp/${action}`;
  if (call.options.openURL) return call.options.openURL(url);
  const app = cardApp(call);
  // The CLI runs inside the app's Electron as Node; the app itself must not.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const [command, args, verbatim] = app ? [app, [url], false]
    : process.platform === 'win32' ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], true] : [undefined, [], false];
  if (!command) throw new ClopMCPError(`Could not open ${url}: Clop's server card names no app.`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env, windowsHide: true, windowsVerbatimArguments: verbatim });
    child.once('error', error => reject(new ClopMCPError(`Could not open ${url}: ${error.message}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** The `mcp` object of `clop mcp status --json`, or undefined when it cannot be read. */
async function mcpStatus(call: Call, timeout = 10) {
  try {
    const result = await run(call, ['mcp', 'status'], timeout);
    return 'json' in result ? (result.json as { mcp?: { enabled?: boolean } }).mcp : undefined;
  } catch { return undefined; }
}

/** Asks the user to allow changes through MCP. Clop shows a dialog and this waits for a person. */
export async function startServer(_: Args, call: Call): Promise<ToolOutput> {
  await openControlURL(call, 'start');
  const deadline = Date.now() + (call.options.startWaitMs ?? 90_000);
  while (Date.now() < deadline && !call.signal?.aborted) {
    // Clop may still be starting, so every round asks again rather than giving up on the first error.
    if ((await mcpStatus(call, 5))?.enabled === true) return status({}, call);
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new ClopMCPError('Clop asked and the answer did not come (or it was no). Nothing changed. Ask the user to allow it in Clop Settings, MCP.');
}

/** Taking permission away needs no dialog, so this never waits. */
export async function stopServer(_: Args, call: Call): Promise<ToolOutput> {
  await openControlURL(call, 'stop');
  return { json: { ok: true, stopped: true, note: 'Clop will refuse changes from agents until it is started again. Reading still works.' } };
}

export async function status(_: Args, call: Call): Promise<ToolOutput> {
  const result = await run(call, ['mcp', 'status']);
  if (!('json' in result) || !result.json || typeof result.json !== 'object') return result;
  const object = { ...result.json as Record<string, unknown> }, info = card(call);
  for (const key of ['version', 'displayName', 'description']) if (object[key] === undefined && info[key] !== undefined) object[key] = info[key];
  return { json: object };
}

/**
 * Refuses before a question when the call would be refused anyway: a question spends the user's attention, and asking
 * how to shrink a file that does not exist, or that Clop will not touch, wastes it.
 */
async function refuseBeforeAsking(call: Call, files: string[] = []) {
  const missing = files.filter(file => !isURL(file) && !exists(local(call, file)));
  if (missing.length) throw new ClopMCPError(`not found: ${missing.join(', ')}`);
  const mcp = await mcpStatus(call);
  if (mcp && mcp.enabled !== true) throw new ClopMCPError(annotate('Clop is not accepting changes from agents.'));
}

// MARK: Questions

type Outcome = { answered: Record<string, unknown> } | 'declined' | 'unanswered' | 'unsupported';

/** Asks the user one question through the client, when it can show a form. */
async function ask(call: Call, message: string, schema: object): Promise<Outcome> {
  if (!call.server.getClientCapabilities()?.elicitation?.form) return 'unsupported';
  const env = call.options.env ?? process.env, seconds = Number(env.CLOP_MCP_ELICIT_TIMEOUT);
  const timeout = call.options.elicitTimeoutMs ?? (seconds > 0 ? seconds * 1000 : 120_000);
  try {
    // A person answers this, so the wait is a person's wait. On timeout the SDK tells the client the question is withdrawn.
    const result = await call.server.elicitInput({ mode: 'form', message, requestedSchema: schema as ElicitRequestFormParams['requestedSchema'] }, { timeout, signal: call.signal });
    if (result.action === 'accept') return { answered: result.content ?? {} };
    return result.action === 'decline' ? 'declined' : 'unanswered';
  } catch (error) {
    if (call.signal?.aborted || (error instanceof McpError && error.code === ErrorCode.RequestTimeout)) return 'unanswered';
    log(`elicitation error: ${error instanceof Error ? error.message : String(error)}`);
    return 'unsupported';
  }
}

/** The question's options as text, for the agent to ask in its own chat. */
const options = (outcome: Exclude<Outcome, { answered: unknown }>, body: string) => ({ text: outcome === 'declined' ? DECLINED_PREFIX + body : outcome === 'unanswered' ? CANCELLED_PREFIX + body : body });

/** Clients may hand back a string where the schema said a number. */
function asNumber(content: Args, key: string): number | undefined {
  const value = content[key];
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.trim().replace(/%$/, ''));
  return value.trim() && Number.isFinite(parsed) ? parsed : undefined;
}

/** One `changeSpeed(...)` step in pipeline text: where its closing parenthesis is, and its arguments. */
interface SpeedStep { close: number; args: string }
const speedFactor = (step: SpeedStep) => { const match = /\bfactor\s*:\s*"?([0-9]*\.?[0-9]+)/.exec(step.args); return match ? Number(match[1]) : undefined; };
/** A slow-down has no extra frames to drop. A factor that can't be read might be a speed-up. */
const needsFrames = (step: SpeedStep) => !/\bframes\s*:/.test(step.args) && (speedFactor(step) ?? 2) > 1;

/** Every `changeSpeed(...)` step. Quoted text is skipped, so a script that mentions changeSpeed is never rewritten. */
export function speedSteps(dsl: string): SpeedStep[] {
  const name = 'changeSpeed', steps: SpeedStep[] = [];
  let i = 0, quoted: string | undefined;
  while (i < dsl.length) {
    const c = dsl[i];
    if (quoted) { if (c === '\\') { i += 2; continue; } if (c === quoted) quoted = undefined; i++; continue; }
    if (c === '"' || c === "'") { quoted = c; i++; continue; }
    if ((i > 0 && /[\p{L}\p{N}_]/u.test(dsl[i - 1])) || !dsl.startsWith(name, i)) { i++; continue; }
    let open = i + name.length;
    while (open < dsl.length && dsl[open] === ' ') open++;
    if (dsl[open] !== '(') { i = open; continue; }
    let close = open + 1, inner: string | undefined;
    while (close < dsl.length && (inner || dsl[close] !== ')')) {
      if (inner && dsl[close] === '\\') { close += 2; continue; }
      if (inner ? dsl[close] === inner : dsl[close] === '"' || dsl[close] === "'") inner = inner ? undefined : dsl[close];
      close++;
    }
    if (close >= dsl.length) break;
    steps.push({ close, args: dsl.slice(open + 1, close) });
    i = close + 1;
  }
  return steps;
}

/** `dsl` with `frames: <value>` written into every speed-up that has none. */
export function withFrames(dsl: string, value: string): string {
  let out = dsl;
  for (const step of speedSteps(dsl).reverse().filter(needsFrames)) {
    const blank = !step.args.trim();
    // Before any trailing spaces, so `changeSpeed( factor: 2 )` keeps its closing space.
    let at = step.close;
    while (!blank && out[at - 1] === ' ') at--;
    out = out.slice(0, at) + (blank ? `frames: ${value}` : `, frames: ${value}`) + out.slice(at);
  }
  return out;
}

/** Whether a run over `list` can reach a video: a folder or a URL can, so only files that are all something else skip the question. */
function mayContainVideo(call: Call, list: string[]) {
  return list.some(item => isURL(item) || !exists(local(call, item))?.isFile() || VIDEO_EXTENSIONS.includes(path.extname(item).slice(1).toLowerCase()));
}

/** The playbackSpeedFrameBehaviour setting in the DSL's words; `keep`, its default, when it can't be read. */
async function currentFrames(call: Call) {
  try {
    const result = await run(call, command(['settings', 'get'], [], ['playbackSpeedFrameBehaviour']), 10);
    return 'json' in result && (result.json as { settings?: { value?: string }[] }).settings?.[0]?.value === 'dropFrames' ? 'drop' : 'keep';
  } catch { return 'keep'; }
}

type Settled = { settled: string } | { askInChat: ToolOutput };

/** Asks whether a video speed-up keeps or drops frames. A malformed answer falls back to the current setting. */
async function askFrames(call: Call, message: string, tool: string, pipeline: boolean, files: string[] = []): Promise<Settled> {
  await refuseBeforeAsking(call, files);
  const current = await currentFrames(call), outcome = await ask(call, message, framesSchema(current));
  if (typeof outcome === 'object') { const answer = outcome.answered.frames; return { settled: answer === 'keep' || answer === 'drop' ? answer : current }; }
  return { askInChat: options(outcome, framesOptionsText(tool, current, pipeline)) };
}

/** Writes the answer into every speed-up in `dsl` that does not say what happens to its frames. */
async function settleSpeedFrames(call: Call, dsl: string, message: string, tool: string, files: string[] = []): Promise<Settled> {
  if (!speedSteps(dsl).some(needsFrames)) return { settled: dsl };
  const answer = await askFrames(call, message, tool, true, files);
  return 'settled' in answer ? { settled: withFrames(dsl, answer.settled) } : answer;
}

// MARK: File operations

const speedQuestion = (what: string) => `When Clop speeds up ${what}, should it keep every frame and make the video smoother or drop frames for smaller size?`;

export async function optimise(a: Args, call: Call): Promise<ToolOutput> {
  const files = paths(a, call);
  let smallerBy = typeof a.smallerBy === 'string' ? a.smallerBy : undefined;
  let compression = a.compression === undefined || a.compression === null ? undefined : argument(a.compression);
  const factor = a.downscaleFactor;
  // The one ambiguous request. A number, a crop, a speed change or audio removal already says what the call is for.
  if (!smallerBy && compression === undefined && factor === undefined && a.crop === undefined && a.playbackSpeedFactor === undefined && a.removeAudio !== true) {
    await refuseBeforeAsking(call, files);
    const outcome = await ask(call, `Clop can make ${subject(files)} smaller in two ways. Which should it use?`, SMALLER_SCHEMA);
    if (typeof outcome !== 'object') return options(outcome, SMALLER_OPTIONS_TEXT);
    smallerBy = typeof outcome.answered.target === 'string' ? outcome.answered.target : 'compression';
    const chosen = asNumber(outcome.answered, 'compression');
    compression = chosen === undefined ? undefined : String(Math.trunc(chosen));
  }
  let frames = a.playbackSpeedFrames === undefined || a.playbackSpeedFrames === null ? undefined : argument(a.playbackSpeedFrames);
  if (frames === undefined && (asNumber(a, 'playbackSpeedFactor') ?? 1) > 1 && mayContainVideo(call, files)) {
    const answer = await askFrames(call, speedQuestion(subject(files)), 'clop_optimise', false, files);
    if ('askInChat' in answer) return answer.askInChat;
    frames = answer.settled;
  }
  const flags = commonFlags(a);
  if (compression !== undefined) flags.push(...given('--compression', compression));
  if (smallerBy === 'resolution' || smallerBy === 'both') flags.push(...given('--downscale-factor', factor === undefined ? '0.5' : argument(factor)));
  else if (factor !== undefined) flags.push(...given('--downscale-factor', argument(factor)));
  flags.push(...opt(a, '--crop', 'crop'), ...opt(a, '--pdf-dpi', 'pdfDPI'), ...opt(a, '--playback-speed-factor', 'playbackSpeedFactor'), ...(frames ? given('--playback-speed-frames', frames) : []), ...flag(a, 'removeAudio', '--remove-audio'));
  return run(call, command(['optimise', 'files'], flags, files), FILE_TIMEOUT);
}

export async function downscale(a: Args, call: Call): Promise<ToolOutput> {
  const files = paths(a, call);
  let factor = a.factor === undefined || a.factor === null ? undefined : argument(a.factor);
  if (factor === undefined) {
    await refuseBeforeAsking(call, files);
    const outcome = await ask(call, `How much smaller should Clop make ${subject(files)}?`, FACTOR_SCHEMA);
    if (typeof outcome !== 'object') return options(outcome, FACTOR_OPTIONS_TEXT);
    factor = String(asNumber(outcome.answered, 'factor') ?? 0.5);
  }
  return run(call, command(['downscale'], [...given('--factor', factor), ...commonFlags(a), ...flag(a, 'removeAudio', '--remove-audio')], files), FILE_TIMEOUT);
}

export async function convert(a: Args, call: Call): Promise<ToolOutput> {
  const kind = typeof a.kind === 'string' ? a.kind : '';
  if (!['image', 'video', 'audio'].includes(kind)) throw new ClopMCPError('kind must be image, video or audio');
  return run(call, command(['convert', kind], [...given('--to', argument(a.to)), ...commonFlags(a), ...opt(a, '--compression', 'compression'), ...opt(a, '--bitrate', 'bitrate'), ...opt(a, '--convert-behaviour', 'convertBehaviour')], paths(a, call)), FILE_TIMEOUT);
}

/** Every flag is written long, since the crop command's `-s` is `--size`. */
export const crop: Handler = (a, call) => run(call, command(['crop'], [...given('--size', argument(a.size)), ...commonFlags(a), ...flag(a, 'longEdge', '--long-edge'), ...flag(a, 'smartCrop', '--smart-crop'), ...flag(a, 'removeAudio', '--remove-audio')], paths(a, call)), FILE_TIMEOUT);

export const stripExif: Handler = (a, call) => text(call, command(['strip-exif'], [...flag(a, 'recursive', '--recursive'), ...opt(a, '--types', 'types')], paths(a, call)), FILE_TIMEOUT);

export async function cropPDF(a: Args, call: Call): Promise<ToolOutput> {
  if (a.forDevice === undefined && a.paperSize === undefined && a.aspectRatio === undefined) throw new ClopMCPError('give one of forDevice, paperSize or aspectRatio');
  try {
    return await text(call, command(['crop-pdf'], [...opt(a, '--for-device', 'forDevice'), ...opt(a, '--paper-size', 'paperSize'), ...opt(a, '--aspect-ratio', 'aspectRatio'), ...opt(a, '--page-layout', 'pageLayout'), ...opt(a, '--output', 'output'), ...flag(a, 'recursive', '--recursive'), ...flag(a, 'extend', '--extend')], paths(a, call)), FILE_TIMEOUT);
  } catch (error) {
    // The CLI points a person at a listing flag; the agent gets the listing itself, and the pointer goes.
    if (!(error instanceof ClopMCPError)) throw error;
    const listing = deviceListing(error.message);
    if (!listing) throw error;
    const shown = await text(call, ['crop-pdf', listing.flag], 10).catch(() => undefined);
    if (!shown || !('text' in shown)) throw error;
    throw new ClopMCPError(`${error.message.replace(listing.pointer, '.')}\n\n${shown.text}`);
  }
}

/** The flag pointer in a bad `--for-device` or `--paper-size` message, and the flag that prints what it points at. */
function deviceListing(message: string) {
  for (const flag of ['--list-devices', '--list-paper-sizes']) {
    const pointer = `, use ${flag} to see possible values`;
    if (message.includes(pointer)) return { pointer, flag };
  }
  return undefined;
}

export const uncropPDF: Handler = (a, call) => text(call, command(['uncrop-pdf'], [...flag(a, 'recursive', '--recursive'), ...opt(a, '--output', 'output')], paths(a, call)), FILE_TIMEOUT);

// MARK: Settings and pipelines

export const settingsSchema: Handler = (a, call) => { const query = typeof a.query === 'string' ? a.query : ''; return run(call, command(['settings', 'schema'], [], query ? [query] : [])); };
export const settingsGet: Handler = (a, call) => run(call, command(['settings', 'get'], [], [argument(a.key)]));
export const settingsSet: Handler = (a, call) => run(call, command(['settings', 'set'], [], [argument(a.key), argument(a.value)]));

export const pipelinePrompt: Handler = (a, call) => { const task = typeof a.task === 'string' ? a.task : ''; return text(call, command(['pipeline', 'prompt'], flag(a, 'compact', '--compact'), task ? [task] : []), 45); };
export const pipelineList: Handler = (a, call) => run(call, ['pipeline', 'list', ...flag(a, 'all', '--all')]);
export const pipelineShow: Handler = (a, call) => run(call, command(['pipeline', 'show'], [], [argument(a.name)]));
export const pipelineDelete: Handler = (a, call) => text(call, command(['pipeline', 'delete'], [], [argument(a.name)]), 60);

/** Whether a pipeline for `type` can reach a video. No type means every type. */
const takesVideo = (type: unknown) => ['', 'video'].includes(argument(type).toLowerCase());
/** How the questions name where an attached pipeline runs. */
const sourceLabel = (source: string) => source === 'clipboard' ? 'the clipboard' : source === 'dropZone' ? 'the drop zone' : `“${path.basename(source.replace(/[\\/]+$/, ''))}”`;

export async function pipelineRun(a: Args, call: Call): Promise<ToolOutput> {
  const files = paths(a, call);
  let pipeline = argument(a.pipeline);
  if (mayContainVideo(call, files)) {
    const settled = await settleSpeedFrames(call, pipeline, speedQuestion(subject(files)), 'clop_pipeline_run', files);
    if ('askInChat' in settled) return settled.askInChat;
    pipeline = settled.settled;
  }
  return run(call, command(['pipeline', 'run'], [...flag(a, 'recursive', '--recursive'), ...flag(a, 'skipErrors', '--skip-errors'), ...flag(a, 'hideResult', '--hide-result'), ...opt(a, '--types', 'types'), ...opt(a, '--optimise-behaviour', 'optimiseBehaviour'), ...opt(a, '--convert-behaviour', 'convertBehaviour'), '--no-progress'], [pipeline, ...files]), FILE_TIMEOUT);
}

export async function pipelineWrite(a: Args, call: Call): Promise<ToolOutput> {
  const name = argument(a.name);
  let steps = argument(a.steps);
  if (takesVideo(a.fileType)) {
    const settled = await settleSpeedFrames(call, steps, `When “${name}” speeds up a video, should Clop keep every frame and make the video smoother or drop frames for smaller size?`, 'clop_pipeline_write');
    if ('askInChat' in settled) return settled.askInChat;
    steps = settled.settled;
  }
  return text(call, command(['pipeline', 'add'], [...opt(a, '--file-type', 'fileType'), ...flag(a, 'skipOptimisation', '--skip-optimisation'), ...flag(a, 'hideResult', '--hide-result'), ...flag(a, 'replace', '--force')], [name, steps]), 60);
}

export async function pipelineAttach(a: Args, call: Call): Promise<ToolOutput> {
  let pipeline = argument(a.pipeline);
  const source = argument(a.source);
  if (takesVideo(a.type)) {
    const settled = await settleSpeedFrames(call, pipeline, `When the pipeline for ${sourceLabel(source)} speeds up a video, should Clop keep every frame and make the video smoother or drop frames for smaller size?`, 'clop_pipeline_attach');
    if ('askInChat' in settled) return settled.askInChat;
    pipeline = settled.settled;
  }
  return text(call, command(['pipeline', 'attach'], [...given('--source', source), ...given('--type', argument(a.type)), ...flag(a, 'skipOptimisation', '--skip-optimisation'), ...flag(a, 'hideResult', '--hide-result')], [pipeline]), 60);
}

export async function pipelineDetach(a: Args, call: Call): Promise<ToolOutput> {
  if (a.index !== undefined && a.all === true) throw new ClopMCPError('pass index or all, not both');
  return text(call, command(['pipeline', 'detach'], [...given('--source', argument(a.source)), ...given('--type', argument(a.type)), ...opt(a, '--index', 'index'), ...flag(a, 'all', '--all')]), 60);
}

export async function pipelinePreset(a: Args, call: Call): Promise<ToolOutput> {
  const action = typeof a.action === 'string' ? a.action : 'add';
  if (action === 'remove') return text(call, command(['pipeline', 'preset', 'remove'], opt(a, '--type', 'type'), [argument(a.name)]), 60);
  let pipeline = argument(a.pipeline);
  if (!pipeline) throw new ClopMCPError('adding a preset zone needs a pipeline: a saved name or inline steps');
  const name = argument(a.name);
  if (takesVideo(a.type)) {
    const settled = await settleSpeedFrames(call, pipeline, `When the “${name}” zone speeds up a video, should Clop keep every frame and make the video smoother or drop frames for smaller size?`, 'clop_pipeline_preset');
    if ('askInChat' in settled) return settled.askInChat;
    pipeline = settled.settled;
  }
  return text(call, command(['pipeline', 'preset', 'add'], [...opt(a, '--type', 'type'), ...opt(a, '--icon', 'icon'), ...flag(a, 'skipOptimisation', '--skip-optimisation'), ...flag(a, 'hideResult', '--hide-result'), ...flag(a, 'replace', '--force')], [name, pipeline]), 60);
}

/** `clop logs persist`. Windows needs no administrator for Clop's own log file, so the MCP switch is the gate. */
export async function debugLogs(a: Args, call: Call): Promise<ToolOutput> {
  const action = a.action;
  if (action !== 'on' && action !== 'off' && action !== 'status') throw new ClopMCPError('action must be on, off or status');
  return text(call, ['logs', 'persist', action]);
}
