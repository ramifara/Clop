import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SettingsRequest } from '../core/ipc/protocol';
import { ExitCode, ValidationError } from './args';
import { flag, on, str, type ClopCommand, type Context } from './context';
import { readSettings } from './read-settings';
import { sortedJSON } from './results';

// `clop settings`, `clop mcp` and `clop logs` (ClopCLI/main.swift).


/** `printSettings`: one settings request, printed as rows or as JSON. */
async function printSettings(ctx: Context, request: SettingsRequest, json: boolean) {
  const response = await (await ctx.backend()).settings({ ...request, origin: ctx.origin });
  if (!response.ok) {
    if (json) { ctx.io.out(`${sortedJSON(response)}\n`); throw new ExitCode(1); }
    throw new ValidationError(response.error ?? 'Clop refused the request.');
  }
  if (json) { ctx.io.out(`${sortedJSON(response)}\n`); return; }
  const settings = response.settings ?? [];
  if (!settings.length) { ctx.io.out('Nothing matched.\n'); return; }
  for (const s of settings) {
    const where = [s.pane, s.section].filter(Boolean).join(' > ');
    const lines = [`${s.title}${where ? `  [${where}]` : ''}`];
    if (s.subtitle) lines.push(`  ${s.subtitle}`);
    lines.push(s.key ? `  ${s.key} = ${s.value}${s.allowed ? `   one of: ${s.allowed.join(', ')}` : ''}` : '  (no single setting behind this row)');
    ctx.io.out(`${lines.join('\n')}\n\n`);
  }
}

const json = flag('json', 'Output as JSON', 'j');

export const settingsCommand: ClopCommand = {
  name: 'settings', abstract: "Read and change Clop's settings.", defaultSubcommand: 'schema',
  subcommands: [
    {
      name: 'schema', abstract: 'Every setting, its value and what it accepts. Pass words to narrow it.', options: [json],
      arguments: [{ name: 'query', help: "Plain language filter, e.g. 'replace the original mov'", variadic: true }],
      async run(v, ctx) { const query = ((v.query as string[] | undefined) ?? []).join(' '); await printSettings(ctx, { action: 'schema', ...(query ? { query } : {}) }, on(v, 'json')); },
    },
    {
      name: 'get', abstract: 'Read one setting by key.', options: [json], arguments: [{ name: 'key', help: 'The setting key' }],
      async run(v, ctx) { await printSettings(ctx, { action: 'get', key: str(v, 'key') }, on(v, 'json')); },
    },
    {
      name: 'set', abstract: 'Change one setting. Applies immediately.', options: [json],
      arguments: [{ name: 'key', help: 'The setting key' }, { name: 'value', help: 'The new value, in the string form the schema shows' }],
      async run(v, ctx) { await printSettings(ctx, { action: 'set', key: str(v, 'key'), value: str(v, 'value') }, on(v, 'json')); },
    },
  ],
};

/** `MCPCommand.Status`: the switches, plus what the server card the app writes says about the server. */
const status: ClopCommand = {
  name: 'status', abstract: 'Whether agents may drive Clop, and where the server lives.', options: [json],
  async run(v, ctx) {
    const settings = await readSettings(ctx), cardPath = path.join(ctx.options.userData, 'mcp.json');
    let card: Record<string, unknown> = {};
    try { card = JSON.parse(await readFile(cardPath, 'utf8')); } catch {}
    const status: Record<string, unknown> = { enabled: settings.mcpEnabled, allowScriptSteps: settings.mcpAllowScriptSteps, requiresPro: false, cardPath };
    if (typeof card.version === 'string') status.version = card.version;
    const app = card.app as { path?: unknown } | undefined, transport = card.transport as { command?: unknown; args?: unknown } | undefined;
    if (typeof app?.path === 'string') status.appPath = app.path;
    if (transport) status.serverCommand = [typeof transport.command === 'string' ? transport.command : '', ...(Array.isArray(transport.args) ? transport.args : [])].join(' ');
    if (on(v, 'json')) { ctx.io.out(`${sortedJSON({ ok: true, mcp: status })}\n`); return; }
    const lines = [`MCP changes:     ${settings.mcpEnabled ? 'allowed' : 'not allowed'}`, `Script steps:    ${settings.mcpAllowScriptSteps ? 'allowed' : 'not allowed'}`];
    if (status.appPath) lines.push(`App:             ${status.appPath}`);
    if (!settings.mcpEnabled) lines.push('', 'Ask the user to allow it in Clop Settings, MCP, or run: start clop://mcp/start');
    ctx.io.out(`${lines.join('\n')}\n`);
  },
};

export const mcpCommand: ClopCommand = {
  name: 'mcp', abstract: 'The MCP server that lets agents drive Clop.', defaultSubcommand: 'status',
  subcommands: [status, {
    name: 'serve', abstract: 'Speak MCP over stdin and stdout.', hidden: true,
    // Loaded here, so no other command pays for the MCP SDK.
    async run(_, ctx) { const { serve } = await import('./mcp'); await serve({ options: ctx.options, cwd: ctx.cwd, home: ctx.home }); },
  }],
};

/**
 * `clop logs persist on|off|status`. macOS switches the system log's persistence; Clop for Windows keeps its own log file,
 * which the `persistDebugLogs` setting turns on.
 */
export const logsCommand: ClopCommand = {
  name: 'logs', subcommands: [{
    name: 'persist', abstract: "Keep Clop's debug logs on disk so they can be read later",
    discussion: 'Clop for Windows writes its debug log to a file in its app data folder while this is on.',
    arguments: [{ name: 'action', help: 'on, off or status' }],
    async run(v, ctx) {
      const action = str(v, 'action')!, file = path.join(ctx.options.userData, 'logs', 'clop.log');
      if (!['on', 'off', 'status'].includes(action)) throw new ValidationError(`The value '${action}' is invalid for '<action>'`);
      if (action === 'status') {
        const settings = await readSettings(ctx);
        ctx.io.out(settings.persistDebugLogs ? `Debug logs for Clop are kept in ${file}\n` : 'Debug logs for Clop are not kept\n');
        return;
      }
      const response = await (await ctx.backend()).settings({ action: 'update', values: { persistDebugLogs: action === 'on' }, origin: ctx.origin });
      if (!response.ok) throw new Error(`Could not change the log settings: ${response.error}`);
      ctx.io.out(action === 'on' ? `Debug logs for Clop are kept now. Read them in:\n    ${file}\n` : 'Debug logs for Clop are back to the default: not kept\n');
    },
  }],
};
