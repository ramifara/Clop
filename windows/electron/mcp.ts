import { existsSync } from 'node:fs';
import path from 'node:path';
import { cardPaths, writeServerCard } from '../core/mcp/card';
import { cliCommand, configOf, configState, installClient, isPresent, mcpClients, removeClient, repairClients, SERVE_ARGS, windowsFolders, type Client, type ServerCommand } from '../core/mcp/clients';
import type { McpRequest, McpState } from '../src/types';

// The MCP pane's main-process half (Clop/MCPSettingsPane.swift, Clop/MCPInstaller.swift): the agents with their state,
// install and remove, the two switches, and the server card. The renderer names a client by id and never a path.

export interface MCPSettingsDeps {
  userData: string;
  home: string;
  /** clop.exe, which is the MCP server, or undefined when this build has none (development). */
  cliPath?: string;
  /** Why there is no server to install, shown in place of the install-by-hand rows. */
  missing: string;
  version: string;
  appPath: string;
  env?: NodeJS.ProcessEnv;
  setSwitches(values: { mcpEnabled?: boolean; mcpAllowScriptSteps?: boolean }): Promise<void>;
  switches(): { mcpEnabled: boolean; mcpAllowScriptSteps: boolean };
  /** Asks before script steps are allowed: they run arbitrary code. */
  confirmScripts(): Promise<boolean>;
  reveal(file: string): void;
  copy(text: string): void;
}

const quoted = (word: string) => /[\s"]/.test(word) ? `"${word}"` : word;

export function parseMCPRequest(value: unknown, clients: readonly Client[]): McpRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose an MCP action.');
  const r = value as Record<string, unknown>;
  switch (r.action) {
    case 'state': return { action: 'state' };
    case 'install': case 'remove': case 'reveal':
      if (typeof r.id !== 'string' || !clients.some(client => client.id === r.id)) throw new Error('Choose an agent from the list.');
      return { action: r.action, id: r.id };
    case 'enable': case 'scripts':
      if (typeof r.on !== 'boolean') throw new Error('Choose on or off.');
      return { action: r.action, on: r.on };
    case 'copy':
      if (r.what !== 'command' && r.what !== 'server') throw new Error('Choose what to copy.');
      return { action: 'copy', what: r.what };
  }
  throw new Error('Choose an MCP action.');
}

export function mcpSettings(deps: MCPSettingsDeps) {
  const clients = mcpClients(windowsFolders(deps.env ?? process.env, deps.home)), backups = path.join(deps.userData, 'mcp-backups');
  /** The last install or remove error per client, until the next one succeeds. */
  const failures = new Map<string, string>();
  const server = (): ServerCommand | undefined => deps.cliPath && existsSync(deps.cliPath) ? { command: deps.cliPath, args: SERVE_ARGS } : undefined;

  async function state(): Promise<McpState> {
    const rows = await Promise.all(clients.map(async client => {
      const configured = await configState(client), file = configOf(client).path, failure = failures.get(client.id);
      // Once it is added, the useful detail is where it landed.
      const detail = failure ?? (configured === 'unusable' ? `${file} is not a JSON object.` : configured === 'installed' || isPresent(client) ? file : 'Not installed on this PC.');
      return { id: client.id, name: client.name, featured: client.featured, state: configured, detail, failed: failure !== undefined };
    }));
    const s = server();
    return { clients: rows, ...(s ? { server: [s.command, ...s.args].map(quoted).join(' '), command: cliCommand(s) } : { missing: deps.missing }) };
  }

  async function edit(id: string, change: (client: Client) => Promise<void>) {
    const client = clients.find(c => c.id === id)!;
    try { await change(client); failures.delete(id); } catch (error) { failures.set(id, error instanceof Error ? error.message : String(error)); }
  }

  return {
    clients,
    state,
    async handle(value: unknown): Promise<McpState> {
      const request = parseMCPRequest(value, clients);
      switch (request.action) {
        case 'install': await edit(request.id, async client => { const s = server(); if (!s) throw new Error(deps.missing); await installClient(client, s, { backups }); }); break;
        case 'remove': await edit(request.id, client => removeClient(client, { backups })); break;
        case 'reveal': deps.reveal(configOf(clients.find(c => c.id === request.id)!).path); break;
        case 'enable': await deps.setSwitches({ mcpEnabled: request.on }); break;
        case 'scripts':
          if (request.on && !deps.switches().mcpEnabled) throw new Error('Enable MCP first.');
          if (!request.on || await deps.confirmScripts()) await deps.setSwitches({ mcpAllowScriptSteps: request.on });
          break;
        case 'copy': { const s = await state(); const text = request.what === 'command' ? s.command : s.server; if (text) deps.copy(text); break; }
      }
      return state();
    },
    /** The card an agent reads to find the server, written at launch and whenever the switch changes. */
    writeCard: () => writeServerCard(cardPaths(deps.userData, deps.home), { version: deps.version, appPath: deps.appPath, enabled: deps.switches().mcpEnabled, cliPath: server()?.command }),
    /** Repoints entries left by a copy of Clop that moved or was replaced. Never adds Clop to an agent. */
    repair: () => { const s = server(); return s ? repairClients(clients, s, { backups }) : Promise.resolve([]); },
  };
}
