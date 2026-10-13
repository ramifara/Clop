import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolvedConfigPath, SERVE_ARGS, SERVER_NAME } from './clients';

// The server card (`MCPInstaller.writeServerCard`): how an agent finds Clop's MCP server, written on every launch and
// whenever the switch changes. It carries no credentials. `clop mcp status` and the server read the copy in the app data
// folder; the one in `%USERPROFILE%\.well-known\mcp` is where an agent is likely to look.

export interface CardFacts { version: string; appPath: string; enabled: boolean; cliPath?: string }

export function serverCard({ version, appPath, enabled, cliPath }: CardFacts) {
  return {
    name: SERVER_NAME,
    displayName: 'Clop',
    description: 'Image, video, PDF and audio optimisation. Run pipelines over files, downscale, convert, crop, author new pipelines, and read or change any Clop setting.',
    version,
    app: { path: appPath },
    enabled,
    requiresPro: false,
    ...(cliPath ? { transport: { type: 'stdio', command: cliPath, args: SERVE_ARGS } } : {}),
    control: {
      start: 'cmd /c start clop://mcp/start',
      stop: 'cmd /c start clop://mcp/stop',
      note: 'Reading works whether or not it is started; changes are refused until it is. Starting sticks across launches until it is stopped.',
    },
  };
}

/** `<userData>\mcp.json` and `%USERPROFILE%\.well-known\mcp\clop.json`. */
export const cardPaths = (userData: string, home: string) => [path.join(userData, 'mcp.json'), path.join(home, '.well-known', 'mcp', 'clop.json')];

export async function writeServerCard(files: string[], facts: CardFacts) {
  const text = `${JSON.stringify(sortKeys(serverCard(facts)), null, 2)}\n`;
  for (const file of files) {
    const target = await resolvedConfigPath(file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}

const sortKeys = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])])) : value;
