import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { INSTRUCTIONS } from './mcp-copy';
import { TOOLS, TOOLS_BY_NAME } from './mcp-table';
import { ClopMCPError, pretty, type MCPOptions } from './mcp-tools';

// `clop mcp serve` (ClopCLI/MCPServer.swift): MCP over stdin and stdout. Everything else goes to stderr, so nothing can
// corrupt the stream.

export const SERVER_NAME = 'clop-mcp', SERVER_VERSION = '2.0.0';

const failure = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** A missing value, as the Swift server counts one: absent, null, an empty string or an empty list. */
const missing = (value: unknown) => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);

export function createServer(options: MCPOptions = {}): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params, args = request.params.arguments ?? {};
    const tool = TOOLS_BY_NAME.get(name);
    if (!tool) return failure(`unknown tool: ${name}`);
    // Checked from the tool's own schema, so a missing argument names itself instead of surfacing as an internal error.
    const absent = (tool.inputSchema.required ?? []).filter(key => missing(args[key]));
    if (absent.length) return failure(`${name} needs ${absent.join(', ')}`);
    try {
      const output = await tool.handler(args, { name, args, signal: extra.signal, server, options });
      return { content: [{ type: 'text', text: 'text' in output ? output.text : pretty(output.json) }] };
    } catch (error) {
      // Clop's own words, with no prefix: they are what the agent should read.
      if (error instanceof ClopMCPError) return failure(error.message);
      return failure(`tool error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return server;
}

/** Serves until the client closes stdin. */
export async function serve(options: MCPOptions = {}): Promise<void> {
  // stdout is the protocol, so anything a library logs goes to stderr instead.
  console.log = console.info = console.debug = console.error;
  process.stderr.write('[clop-mcp] starting\n');
  const server = createServer(options), transport = new StdioServerTransport();
  const closed = new Promise<void>(resolve => { server.onclose = resolve; process.stdin.once('end', resolve); });
  await server.connect(transport);
  await closed;
  await server.close().catch(() => {});
}
