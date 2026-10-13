import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type CallToolResult, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './mcp';
import type { MCPOptions } from './mcp-tools';

/** Removes a test folder, waiting out a program that has not quite let go of it yet (Windows cannot delete what is open). */
export const removeFolder = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

/** A folder with an app data folder holding `settings`, and no running app, so every tool runs headless. */
export async function folder(t: TestContext, settings: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-mcp-'));
  t.after(() => removeFolder(dir));
  const userData = path.join(dir, 'data'), file = (name: string) => path.join(dir, name);
  const settle = (values: Record<string, unknown>) => writeFile(path.join(userData, 'settings.json'), JSON.stringify(values));
  await mkdir(userData, { recursive: true });
  await settle(settings);
  return { dir, userData, file, settle, settings: async () => JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8')) };
}

/** A client connected in memory to a server for `dir`. `answer` answers questions when given; without it the client cannot show one. */
export async function connect(t: TestContext, f: Awaited<ReturnType<typeof folder>>, { answer, opened, extra }: { answer?: () => ElicitResult; opened?: string[]; extra?: Partial<MCPOptions> } = {}) {
  const server = createServer({ options: { userData: f.userData, home: f.dir }, cwd: f.dir, home: f.dir, env: {}, log: () => {}, startWaitMs: 3000, openURL: async url => { opened?.push(url); if (url.endsWith('start')) await f.settle({ ...await f.settings(), mcpEnabled: true }); }, ...extra });
  const client = new Client({ name: 'test', version: '1' }, answer ? { capabilities: { elicitation: { form: {} } } } : {});
  if (answer) client.setRequestHandler(ElicitRequestSchema, async () => answer());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    return { error: result.isError === true, text: (result.content[0] as { text: string }).text };
  };
  return { client, call };
}
