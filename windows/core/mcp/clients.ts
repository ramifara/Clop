import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { retryBusy } from '../run';
import { NotAnObjectError, readObject, removeMember, setMember } from './jsonc';
import { ConfigLayoutError } from './lines';
import { commandWords, removeCommand, setCommand, shellQuote } from './shellrc';
import { removeTable, setTable, tableValues, tomlStrings } from './toml';
import { childFields, removeChild, setChild } from './yaml';

// The agents Clop's MCP server installs into (Clop/MCPClients.swift, Clop/MCPInstaller.swift), where each keeps its
// servers on Windows, and the edits that put one entry in and take it back out without touching anything else.

/** How a client's config file holds its servers. */
export type Style =
  /** `mcpServers`, command and args side by side: Claude Code, Claude Desktop, pi, Gemini CLI, Antigravity, Qwen Code, Kimi Code, Devin and Cursor. */
  | 'mcpServers'
  /** `mcpServers` with `"type": "stdio"`: Factory Droid. */
  | 'droid'
  /** `mcpServers` with `"type": "local"` and a tool allowlist: Copilot CLI. */
  | 'copilot'
  /** `amp.mcpServers`, a dotted name at the top level: Amp. */
  | 'amp'
  /** `mcp`, with the command and its arguments in one array: OpenCode. */
  | 'openCode'
  /** `mcp` with `"type": "stdio"`: Crush's `crush.json`. */
  | 'crushJSON'
  /** `servers` with `"type": "stdio"`: VS Code. */
  | 'vsCode'
  /** `context_servers`, command and args side by side: Zed. */
  | 'zed'
  /** A `[mcp_servers.<name>]` table in TOML: Codex. */
  | 'codex'
  /** `extensions.<name>` in YAML: Goose. */
  | 'goose'
  /** An `mcp add` command in a Bash file: Crush. */
  | 'crushrc';

export interface Config { path: string; style: Style }
export interface Client {
  id: string;
  name: string;
  /** Where the client reads its servers, in its own order. The first on disk is edited; with none there, the first is created. */
  configs: Config[];
  /** Files and folders that show the client is on this PC. */
  evidence: string[];
  /** Shown above "See more". */
  featured: boolean;
}
/** The command an entry runs: clop.exe and `mcp serve`. */
export interface ServerCommand { command: string; args: string[] }
export type ConfigState = 'installed' | 'notInstalled' | 'unusable';

export const SERVER_NAME = 'clop';
export const SERVE_ARGS = ['mcp', 'serve'];

/** The folders the paths below hang off. */
export interface Folders { home: string; appData: string; localAppData: string }
export function windowsFolders(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Folders {
  return { home, appData: env.APPDATA || path.join(home, 'AppData', 'Roaming'), localAppData: env.LOCALAPPDATA || path.join(home, 'AppData', 'Local') };
}

/** Every client, featured first, in the macOS order. */
export function mcpClients({ home, appData, localAppData }: Folders): Client[] {
  const h = (...parts: string[]) => path.join(home, ...parts), roaming = (...parts: string[]) => path.join(appData, ...parts), local = (...parts: string[]) => path.join(localAppData, ...parts);
  /** Where a CLI's installer usually puts it on Windows. */
  const binaries = (name: string) => [h('.local', 'bin', `${name}.exe`), roaming('npm', `${name}.cmd`), h('.bun', 'bin', `${name}.exe`), local('Microsoft', 'WinGet', 'Links', `${name}.exe`), h('scoop', 'shims', `${name}.exe`)];
  const client = (featured: boolean, id: string, name: string, configs: Config[], evidence: string[]): Client => ({ id, name, configs, evidence, featured });
  const one = (file: string, style: Style) => [{ path: file, style }];
  return [
    client(true, 'claude-code', 'Claude Code', one(h('.claude.json'), 'mcpServers'), [h('.claude'), ...binaries('claude')]),
    client(true, 'claude-desktop', 'Claude Desktop', one(roaming('Claude', 'claude_desktop_config.json'), 'mcpServers'), [local('AnthropicClaude'), roaming('Claude')]),
    // The ChatGPT desktop app runs Codex too and reads the same config.toml.
    client(true, 'codex', 'Codex', one(h('.codex', 'config.toml'), 'codex'), [h('.codex'), ...binaries('codex')]),
    client(true, 'copilot', 'Copilot CLI', one(h('.copilot', 'mcp-config.json'), 'copilot'), [h('.copilot'), ...binaries('copilot')]),
    client(true, 'pi', 'pi', one(h('.pi', 'agent', 'mcp.json'), 'mcpServers'), [h('.pi'), ...binaries('pi')]),
    client(true, 'opencode', 'OpenCode', [{ path: h('.config', 'opencode', 'opencode.json'), style: 'openCode' }, { path: h('.config', 'opencode', 'opencode.jsonc'), style: 'openCode' }], [h('.config', 'opencode'), h('.opencode'), ...binaries('opencode')]),
    client(true, 'gemini', 'Gemini CLI', one(h('.gemini', 'settings.json'), 'mcpServers'), binaries('gemini')),
    // One file for the agy CLI and the Antigravity app.
    client(false, 'antigravity', 'Antigravity', one(h('.gemini', 'config', 'mcp_config.json'), 'mcpServers'), [local('Programs', 'Antigravity'), h('.gemini', 'antigravity'), ...binaries('agy')]),
    client(false, 'amp', 'Amp', one(h('.config', 'amp', 'settings.json'), 'amp'), [h('.config', 'amp'), h('.amp'), ...binaries('amp')]),
    client(false, 'droid', 'Factory Droid', one(h('.factory', 'mcp.json'), 'droid'), [h('.factory'), ...binaries('droid')]),
    client(false, 'goose', 'Goose', one(roaming('Block', 'goose', 'config', 'config.yaml'), 'goose'), [roaming('Block', 'goose'), local('Programs', 'Goose'), ...binaries('goose')]),
    // Crush warns when a folder has both, so a second file is never started next to the one in use.
    client(false, 'crush', 'Crush', [{ path: local('crush', 'crushrc'), style: 'crushrc' }, { path: local('crush', 'crush.json'), style: 'crushJSON' }], [local('crush'), ...binaries('crush')]),
    client(false, 'qwen', 'Qwen Code', one(h('.qwen', 'settings.json'), 'mcpServers'), [h('.qwen'), ...binaries('qwen')]),
    client(false, 'kimi', 'Kimi Code', one(h('.kimi-code', 'mcp.json'), 'mcpServers'), [h('.kimi-code'), ...binaries('kimi')]),
    // The Devin CLI, and Windsurf since it became Devin Desktop.
    client(false, 'devin', 'Devin', one(h('.config', 'devin', 'mcp_config.json'), 'mcpServers'), [local('Programs', 'Devin'), local('Programs', 'Windsurf'), h('.codeium', 'windsurf'), ...binaries('devin')]),
    client(false, 'cursor', 'Cursor', one(h('.cursor', 'mcp.json'), 'mcpServers'), [local('Programs', 'cursor'), h('.cursor'), ...binaries('cursor-agent')]),
    client(false, 'vscode', 'VS Code', one(roaming('Code', 'User', 'mcp.json'), 'vsCode'), [local('Programs', 'Microsoft VS Code'), roaming('Code')]),
    client(false, 'vscode-insiders', 'VS Code Insiders', one(roaming('Code - Insiders', 'User', 'mcp.json'), 'vsCode'), [local('Programs', 'Microsoft VS Code Insiders'), roaming('Code - Insiders')]),
    client(false, 'zed', 'Zed', one(roaming('Zed', 'settings.json'), 'zed'), [local('Programs', 'Zed'), roaming('Zed')]),
  ];
}

/** The config that is edited: the first one on disk, else the first. */
export const configOf = (client: Client) => client.configs.find(config => existsSync(config.path)) ?? client.configs[0];
export const isPresent = (client: Client) => client.configs.some(config => existsSync(config.path)) || client.evidence.some(file => existsSync(file));

/** The top-level key holding the servers, or undefined for a file that is not JSON. */
function container(style: Style): string | undefined {
  switch (style) {
    case 'mcpServers': case 'droid': case 'copilot': return 'mcpServers';
    case 'amp': return 'amp.mcpServers';
    case 'openCode': case 'crushJSON': return 'mcp';
    case 'vsCode': return 'servers';
    case 'zed': return 'context_servers';
    default: return undefined;
  }
}

const json = (value: string) => JSON.stringify(value);

/** The JSON member, formatted, as it lands in the file. */
export function jsonEntry(style: Style, { command, args }: ServerCommand): string {
  const list = (items: string[]) => items.map(json).join(', ');
  switch (style) {
    case 'openCode': return `{\n  "type": "local",\n  "command": [${list([command, ...args])}],\n  "enabled": true\n}`;
    case 'copilot': return `{\n  "type": "local",\n  "command": ${json(command)},\n  "args": [${list(args)}],\n  "tools": ["*"]\n}`;
    case 'droid': case 'crushJSON': case 'vsCode': return `{\n  "type": "stdio",\n  "command": ${json(command)},\n  "args": [${list(args)}]\n}`;
    default: return `{\n  "command": ${json(command)},\n  "args": [${list(args)}]\n}`;
  }
}

/** TOML basic strings take JSON's escapes. */
const codexBody = ({ command, args }: ServerCommand) => [`command = ${json(command)}`, `args = [${args.map(json).join(', ')}]`];
/** Goose reads every extension as `enabled` plus its type's fields. Double-quoted YAML takes JSON's escapes. */
const gooseBody = ({ command, args }: ServerCommand) => ['enabled: true', 'type: stdio', `name: ${json(SERVER_NAME)}`, `cmd: ${json(command)}`, 'args:', ...args.map(arg => `- ${json(arg)}`), 'envs: {}', 'timeout: 300'];
const crushLine = ({ command, args }: ServerCommand) => ['mcp', 'add', SERVER_NAME, '--command', command, ...args.flatMap(arg => ['--args', arg])].map(shellQuote).join(' ');

/** The entry in a TOML, YAML or Bash config: undefined when it is not there, `command` undefined when it is there in a shape this cannot read. */
function textEntry(text: string, style: Style): { command?: string; args: string[] } | undefined {
  if (style === 'codex') {
    const values = tableValues(text, ['mcp_servers', SERVER_NAME]);
    return values && { command: values.command ? tomlStrings(values.command)?.[0] : undefined, args: (values.args ? tomlStrings(values.args) : undefined) ?? [] };
  }
  if (style === 'goose') { const fields = childFields(text, 'extensions', SERVER_NAME); return fields && { command: fields.cmd?.[0], args: fields.args ?? [] }; }
  const words = commandWords(text, ['mcp', 'add', SERVER_NAME]);
  if (!words) return undefined;
  let command: string | undefined;
  const args: string[] = [];
  for (let i = 3; i < words.length; i++) {
    const word = words[i];
    if ((word === '--command' || word === '--args') && i + 1 < words.length) { if (word === '--command') command = words[i + 1]; else args.push(words[i + 1]); i++; }
    else if (word.startsWith('--command=')) command = word.slice(10);
    else if (word.startsWith('--args=')) args.push(word.slice(7));
  }
  return { command, args };
}

const read = (file: string) => readFile(file, 'utf8').then(text => text.replace(/^﻿/, ''), (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });

/** What the client's config says. Only a JSON file that is not an object, even with its comments out, is unusable. */
export async function configState(client: Client): Promise<ConfigState> {
  const config = configOf(client), key = container(config.style), text = await read(config.path).catch(() => undefined);
  if (text === undefined) return 'notInstalled';
  if (!key) return textEntry(text, config.style) ? 'installed' : 'notInstalled';
  try { const servers = readObject(text)[key]; return servers && typeof servers === 'object' && Object.hasOwn(servers, SERVER_NAME) ? 'installed' : 'notInstalled'; } catch { return 'unusable'; }
}

/** The command and arguments a client's entry points at, or undefined when there is none or it cannot be read. */
export async function installedCommand(client: Client): Promise<ServerCommand | undefined> {
  const config = configOf(client), key = container(config.style), text = await read(config.path).catch(() => undefined);
  if (text === undefined) return undefined;
  if (!key) { const entry = textEntry(text, config.style); return entry?.command ? { command: entry.command, args: entry.args } : undefined; }
  let member: Record<string, unknown> | undefined;
  try { member = (readObject(text)[key] as Record<string, Record<string, unknown>> | undefined)?.[SERVER_NAME]; } catch { return undefined; }
  if (!member || typeof member !== 'object') return undefined;
  const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined;
  if (config.style === 'openCode') { const parts = strings(member.command); return parts?.length ? { command: parts[0], args: parts.slice(1) } : undefined; }
  // Zed used to nest the pair under `command` and moves it flat on launch; either may be here.
  const nested = config.style === 'zed' && member.command && typeof member.command === 'object' ? member.command as Record<string, unknown> : undefined;
  const command = nested ? nested.path : member.command;
  return typeof command === 'string' ? { command, args: strings((nested ?? member).args) ?? [] } : undefined;
}

export interface EditOptions {
  /** Each config is copied here before it changes: `<backups>\<client id>\<time>-<file name>`, the newest ten kept. */
  backups?: string;
}

/** Puts the server into the client's config. */
export async function installClient(client: Client, server: ServerCommand, options: EditOptions = {}) {
  const config = configOf(client);
  await edit(client, config, text => {
    switch (config.style) {
      case 'codex': return setTable(text, ['mcp_servers', SERVER_NAME], codexBody(server));
      case 'goose': return setChild(text, 'extensions', SERVER_NAME, gooseBody(server));
      case 'crushrc': return setCommand(text, ['mcp', 'add', SERVER_NAME], crushLine(server));
      default: return setMember(text, container(config.style)!, SERVER_NAME, jsonEntry(config.style, server));
    }
  }, options);
}

/** Takes the server out. A file that holds no entry of ours is never written. */
export async function removeClient(client: Client, options: EditOptions = {}) {
  const config = configOf(client);
  await edit(client, config, text => {
    switch (config.style) {
      case 'codex': return removeTable(text, ['mcp_servers', SERVER_NAME]);
      case 'goose': return removeChild(text, 'extensions', SERVER_NAME);
      case 'crushrc': return removeCommand(text, ['mcp', 'add', SERVER_NAME]);
      default: return removeMember(text, container(config.style)!, SERVER_NAME);
    }
  }, options);
}

/**
 * Where the bytes of a config live. People keep these files in a dotfiles repo and link them into place, and replacing
 * the link with a file would cut it off, so each link is followed, even one whose target does not exist yet.
 */
export async function resolvedConfigPath(file: string): Promise<string> {
  const follow = async (start: string) => {
    let current = path.resolve(start);
    for (let hops = 0; hops < 16; hops++) {
      const info = await lstat(current).catch(() => undefined);
      if (!info?.isSymbolicLink()) return current;
      current = path.resolve(path.dirname(current), await readlink(current));
    }
    return current;
  };
  const resolvedParent = async (dir: string): Promise<string> => { const parent = path.dirname(dir); return parent === dir ? dir : follow(path.join(await resolvedParent(parent), path.basename(dir))); };
  return follow(path.join(await resolvedParent(path.dirname(path.resolve(file))), path.basename(file)));
}

/**
 * Reads the file as text, splices it, writes it back through a temporary file. `change` returns undefined when there is
 * nothing to do, and then nothing is written. The read happens as late as possible: some clients rewrite their config
 * while they run. A UTF-8 byte order mark and the file's permissions are kept.
 */
async function edit(client: Client, config: Config, change: (text: string) => string | undefined, options: EditOptions) {
  const target = await resolvedConfigPath(config.path), raw = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  const bom = raw?.startsWith('﻿') ? '﻿' : '', existing = raw === undefined ? '' : raw.slice(bom.length);
  let updated: string | undefined;
  try { updated = change(existing); } catch (error) {
    if (error instanceof ConfigLayoutError) throw new Error(`${config.path} has a layout that can't be edited safely.`);
    if (error instanceof NotAnObjectError) throw new Error(`${config.path} is not a JSON object.`);
    throw error;
  }
  if (updated === undefined || updated === existing) return;
  const mode = raw === undefined ? undefined : (await stat(target)).mode & 0o777;
  if (raw !== undefined && options.backups) await backup(target, path.join(options.backups, client.id));
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bom + updated, 'utf8');
    if (mode !== undefined && process.platform !== 'win32') await chmod(temp, mode);
    await retryBusy(() => rename(temp, target));
  } finally { await rm(temp, { force: true }); }
}

let backups = 0;
async function backup(file: string, dir: string) {
  await mkdir(dir, { recursive: true });
  // Names sort in the order the backups were taken.
  const stamp = new Date().toISOString().replace(/[-:.]/g, ''), sequence = String(backups++ % 10_000).padStart(4, '0');
  await copyFile(file, path.join(dir, `${stamp}-${sequence}-${path.basename(file)}`));
  const old = (await readdir(dir)).sort().slice(0, -10);
  await Promise.all(old.map(name => rm(path.join(dir, name), { force: true })));
}

/** Whether an entry runs something that is no longer there. An entry pointing at another working copy of Clop is left alone. */
export function entryIsBroken({ command, args }: ServerCommand): boolean {
  if (!existsSync(command)) return true;
  // Only arguments that are absolute paths, so `mcp` and `serve` are never mistaken for files.
  return args.some(arg => path.isAbsolute(arg) && !existsSync(arg));
}

/** Repairs entries that no longer start anything, such as one left by a copy of Clop that moved. Never adds Clop to a client. */
export async function repairClients(clients: Client[], server: ServerCommand, options: EditOptions = {}): Promise<string[]> {
  if (!existsSync(server.command)) return [];
  const repaired: string[] = [];
  for (const client of clients) {
    const current = await installedCommand(client);
    if (!current || !entryIsBroken(current)) continue;
    await installClient(client, server, options).then(() => repaired.push(client.name), () => {});
  }
  return repaired;
}

/** The one-liner for Claude Code, typed in a terminal. */
export const cliCommand = ({ command, args }: ServerCommand) => `claude mcp add --scope user ${SERVER_NAME} -- ${[command, ...args].map(word => /[\s"]/.test(word) ? `"${word}"` : word).join(' ')}`;
