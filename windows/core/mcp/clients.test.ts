import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { cardPaths, writeServerCard } from './card';
import { cliCommand, configOf, configState, entryIsBroken, installClient, installedCommand, isPresent, mcpClients, removeClient, repairClients, type Client, type ServerCommand } from './clients';
import { readObject } from './jsonc';

const FIXTURES = path.join(import.meta.dirname, '..', '..', 'fixtures', 'mcp');
const SERVER: ServerCommand = { command: 'C:\\Program Files\\Clop for Windows\\cli\\clop.exe', args: ['mcp', 'serve'] };
const Q = JSON.stringify(SERVER.command);

/** A user profile with its roaming and local app data folders, and every client's config path under it. */
async function profile(t: TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'clop-mcp-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const folders = { home, appData: path.join(home, 'AppData', 'Roaming'), localAppData: path.join(home, 'AppData', 'Local') };
  const clients = mcpClients(folders), backups = path.join(home, 'backups');
  const client = (id: string) => clients.find(c => c.id === id)!;
  /** Puts a fixture where `config` of `id` lives and returns its text. */
  const place = async (id: string, fixture: string, config = 0) => {
    const file = client(id).configs[config].path;
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(path.join(FIXTURES, fixture), file);
    return readFile(file, 'utf8');
  };
  const text = (id: string) => readFile(configOf(client(id)).path, 'utf8');
  return { home, folders, clients, client, place, text, backups };
}

/** Install, check, reinstall (no change), remove: the file is back to its exact bytes, and a backup was taken. */
async function roundTrip(p: Awaited<ReturnType<typeof profile>>, id: string, original: string, expected: string) {
  const client = p.client(id);
  await installClient(client, SERVER, { backups: p.backups });
  assert.equal(await p.text(id), expected, `${id} after install`);
  assert.equal(await configState(client), 'installed');
  assert.deepEqual(await installedCommand(client), SERVER);
  await installClient(client, SERVER, { backups: p.backups });
  assert.equal(await p.text(id), expected, `${id} reinstall changes nothing`);
  await removeClient(client, { backups: p.backups });
  assert.equal(await p.text(id), original, `${id} after remove`);
  assert.equal(await configState(client), 'notInstalled');
  const saved = await readdir(path.join(p.backups, id));
  assert.equal(saved.length, 2, 'one backup per change that was written');
  assert.equal(await readFile(path.join(p.backups, id, saved.sort()[0]), 'utf8'), original);
}

test('Zed: the member lands in context_servers and every comment and trailing comma stays', async t => {
  const p = await profile(t), original = await p.place('zed', 'zed-settings.json');
  const expected = original.replace('  "context_servers": {\n', `  "context_servers": {\n    "clop": {\n      "command": ${Q},\n      "args": ["mcp", "serve"]\n    },\n`);
  await roundTrip(p, 'zed', original, expected);
});

test('VS Code: a tab-indented mcp.json with comments gets a stdio server under servers', async t => {
  const p = await profile(t), original = await p.place('vscode', 'vscode-mcp.json');
  const expected = original.replace('\t"servers": {\n', `\t"servers": {\n\t\t"clop": {\n\t\t\t"type": "stdio",\n\t\t\t"command": ${Q},\n\t\t\t"args": ["mcp", "serve"]\n\t\t},\n`);
  await roundTrip(p, 'vscode', original, expected);
  assert.equal(p.client('vscode-insiders').configs[0].path, path.join(p.folders.appData, 'Code - Insiders', 'User', 'mcp.json'));
});

test('Claude Desktop: mcpServers is added as the first key and taken out whole', async t => {
  const p = await profile(t), original = await p.place('claude-desktop', 'claude_desktop_config.json');
  assert.equal(configOf(p.client('claude-desktop')).path, path.join(p.folders.appData, 'Claude', 'claude_desktop_config.json'));
  const expected = original.replace('{\n', `{\n  "mcpServers": {\n    "clop": {\n      "command": ${Q},\n      "args": ["mcp", "serve"]\n    }\n  },\n`);
  await roundTrip(p, 'claude-desktop', original, expected);
});

test('OpenCode: the command and its arguments go in one array, beside a remote server', async t => {
  const p = await profile(t), original = await p.place('opencode', 'opencode.jsonc', 1);
  assert.equal(configOf(p.client('opencode')).path, p.client('opencode').configs[1].path, 'the .jsonc on disk is the one edited');
  const expected = original.replace('  "mcp": {\n', `  "mcp": {\n    "clop": {\n      "type": "local",\n      "command": [${Q}, "mcp", "serve"],\n      "enabled": true\n    },\n`);
  await roundTrip(p, 'opencode', original, expected);
});

test('Codex: a [mcp_servers.clop] table after the rest, comments and multi-line arrays untouched', async t => {
  const p = await profile(t), original = await p.place('codex', 'codex-config.toml');
  await roundTrip(p, 'codex', original, `${original}\n[mcp_servers.clop]\ncommand = ${Q}\nargs = ["mcp", "serve"]\n`);
});

test('Goose: a stdio extension under extensions, before the next top-level key', async t => {
  const p = await profile(t), original = await p.place('goose', 'goose-config.yaml');
  assert.equal(configOf(p.client('goose')).path, path.join(p.folders.appData, 'Block', 'goose', 'config', 'config.yaml'));
  const block = `  clop:\n    enabled: true\n    type: stdio\n    name: "clop"\n    cmd: ${Q}\n    args:\n    - "mcp"\n    - "serve"\n    envs: {}\n    timeout: 300\n`;
  await roundTrip(p, 'goose', original, original.replace('GOOSE_MODE:', `${block}GOOSE_MODE:`));
});

test('Crush: an mcp add line in crushrc, or a stdio member in crush.json when that is the file in use', async t => {
  const p = await profile(t), original = await p.place('crush', 'crushrc');
  await roundTrip(p, 'crush', original, `${original}mcp add clop --command 'C:\\Program Files\\Clop for Windows\\cli\\clop.exe' --args mcp --args serve\n`);
  await rm(p.client('crush').configs[0].path);
  await writeFile(p.client('crush').configs[1].path, '{}\n');
  await installClient(p.client('crush'), SERVER);
  assert.deepEqual(readObject(await p.text('crush')), { mcp: { clop: { type: 'stdio', command: SERVER.command, args: SERVER.args } } });
});

test('a client with no config yet gets a new file in its own shape', async t => {
  const p = await profile(t);
  const shapes: Record<string, object> = {
    'claude-code': { mcpServers: { clop: { command: SERVER.command, args: SERVER.args } } },
    droid: { mcpServers: { clop: { type: 'stdio', command: SERVER.command, args: SERVER.args } } },
    copilot: { mcpServers: { clop: { type: 'local', command: SERVER.command, args: SERVER.args, tools: ['*'] } } },
    amp: { 'amp.mcpServers': { clop: { command: SERVER.command, args: SERVER.args } } },
    cursor: { mcpServers: { clop: { command: SERVER.command, args: SERVER.args } } },
  };
  for (const [id, shape] of Object.entries(shapes)) {
    await installClient(p.client(id), SERVER);
    assert.deepEqual(JSON.parse(await p.text(id)), shape, id);
  }
  assert.equal(await p.text('droid'), `{\n  "mcpServers": {\n    "clop": {\n      "type": "stdio",\n      "command": ${Q},\n      "args": ["mcp", "serve"]\n    }\n  }\n}\n`);
  assert.equal(configOf(p.client('claude-code')).path, path.join(p.home, '.claude.json'));
  assert.equal(configOf(p.client('cursor')).path, path.join(p.home, '.cursor', 'mcp.json'));
  await installClient(p.client('codex'), SERVER);
  assert.equal(await p.text('codex'), `[mcp_servers.clop]\ncommand = ${Q}\nargs = ["mcp", "serve"]\n`);
  await removeClient(p.client('codex'));
  assert.equal(await p.text('codex'), '');
});

test('line endings, a byte order mark and an existing entry pointing elsewhere', async t => {
  const p = await profile(t), file = configOf(p.client('cursor')).path;
  await mkdir(path.dirname(file), { recursive: true });
  const original = '\uFEFF{\r\n  // mine\r\n  "mcpServers": {\r\n    "clop": { "command": "D:\\\\old\\\\clop.exe", "args": [] },\r\n    "other": { "command": "x" }\r\n  }\r\n}\r\n';
  await writeFile(file, original);
  await installClient(p.client('cursor'), SERVER);
  const text = await readFile(file, 'utf8');
  assert.ok(text.startsWith('\uFEFF{\r\n  // mine\r\n'), 'byte order mark and comment kept');
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, 'every inserted line ends in CRLF');
  assert.deepEqual(await installedCommand(p.client('cursor')), SERVER);
  assert.deepEqual(Object.keys((readObject(text.slice(1)).mcpServers as object)), ['clop', 'other']);
  await removeClient(p.client('cursor'));
  assert.equal(await readFile(file, 'utf8'), '\uFEFF{\r\n  // mine\r\n  "mcpServers": {\r\n    "other": { "command": "x" }\r\n  }\r\n}\r\n');
});

test('files that cannot be edited safely are refused and left alone', async t => {
  const p = await profile(t);
  const cases: [string, string, RegExp][] = [
    ['claude-code', '[1, 2]\n', /\.claude\.json is not a JSON object\./],
    ['codex', 'mcp_servers = { other = { command = "x" } }\n', /config\.toml has a layout that can't be edited safely\./],
    ['goose', 'extensions:\n\tdeveloper:\n\t\tenabled: true\n', /config\.yaml has a layout that can't be edited safely\./],
    ['goose', 'extensions: { developer: { enabled: true } }\n', /config\.yaml has a layout/],
  ];
  for (const [id, content, error] of cases) {
    const file = configOf(p.client(id)).path;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    await assert.rejects(installClient(p.client(id), SERVER), error);
    assert.equal(await readFile(file, 'utf8'), content);
  }
  assert.equal(await configState(p.client('claude-code')), 'unusable');
});

test('the entry is written in the file\'s own indent: four spaces or tabs', async t => {
  const p = await profile(t);
  const file = configOf(p.client('cursor')).path;
  await mkdir(path.dirname(file), { recursive: true });
  for (const unit of ['    ', '\t']) {
    const before = `{\n${unit}"theme": "x",\n${unit}"mcpServers": {\n${unit}${unit}"other": { "command": "x" }\n${unit}}\n}\n`;
    await writeFile(file, before);
    await installClient(p.client('cursor'), SERVER);
    const entry = [`"clop": {`, `${unit}"command": ${Q},`, `${unit}"args": ["mcp", "serve"]`, '},'].map(line => `${unit}${unit}${line}`).join('\n');
    assert.equal(await readFile(file, 'utf8'), before.replace(`${unit}${unit}"other"`, `${entry}\n${unit}${unit}"other"`));
    await removeClient(p.client('cursor'));
    assert.equal(await readFile(file, 'utf8'), before);
  }
});

test('a member whose key is written with escapes is found as the parser reads it', async t => {
  const p = await profile(t);
  const file = configOf(p.client('cursor')).path;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{ "mcpServers": { "cl\\u006fp": { "command": "old" }, "other": { "command": "x" } } }\n');
  assert.equal(await configState(p.client('cursor')), 'installed');
  await installClient(p.client('cursor'), SERVER);
  assert.deepEqual(Object.keys(readObject(await readFile(file, 'utf8')).mcpServers as object), ['clop', 'other'], 'replaced in place, not added twice');
  assert.deepEqual(await installedCommand(p.client('cursor')), SERVER);
  await removeClient(p.client('cursor'));
  assert.deepEqual(Object.keys(readObject(await readFile(file, 'utf8')).mcpServers as object), ['other']);
});

test('a JSON file that is not valid JSON is refused whole: nothing is written, not even a backup', async t => {
  const p = await profile(t);
  const cases: [string, string][] = [
    ['cursor', '{\n  mcpServers: { other: { command: "x" } },\n}\n'],
    ['cursor', "{\n  'mcpServers': { 'other': { 'command': 'x' } }\n}\n"],
    ['zed', '{\n  "theme": "One",\n  "context_servers": { "other": { "command": "x" } },\n}} oops\n'],
    ['vscode', '{ "servers": { "other": { "command": "x" } } '],
    ['claude-code', '{ "mcpServers": { "clop": { "command": "old" }, } } {}'],
    ['cursor', '{ "mcpServers": {} } /* never closed'],
  ];
  for (const [id, content] of cases) {
    const file = configOf(p.client(id)).path;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    assert.equal(await configState(p.client(id)), 'unusable', content);
    await assert.rejects(installClient(p.client(id), SERVER, { backups: p.backups }), /is not a JSON object/, content);
    await assert.rejects(removeClient(p.client(id), { backups: p.backups }), /is not a JSON object/, content);
    assert.equal(await readFile(file, 'utf8'), content);
  }
  await assert.rejects(readdir(p.backups), { code: 'ENOENT' });
});

test('a key listed twice where Clop writes makes the file unusable', async t => {
  const p = await profile(t);
  const cases: [string, string][] = [
    ['cursor', '{ "mcpServers": { "a": { "command": "x" } }, "mcpServers": { "b": { "command": "y" } } }\n'],
    ['cursor', '{ "mcpServers": { "clop": { "command": "old" }, "clop": { "command": "older" } } }\n'],
    ['zed', '{ "context_servers": {}, // first\n  "context_servers": { "clop": { "command": "old" } } }\n'],
  ];
  const layoutCases: [string, string][] = [
    ['goose', 'extensions:\n  developer:\n    enabled: true\nextensions:\n  clop:\n    cmd: old\n'],
    ['goose', 'extensions:\n  clop:\n    cmd: old\n  clop:\n    cmd: older\n'],
  ];
  for (const [id, content] of layoutCases) {
    const file = configOf(p.client(id)).path;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    await assert.rejects(installClient(p.client(id), SERVER, { backups: p.backups }), /layout that can't be edited safely/, content);
    await assert.rejects(removeClient(p.client(id), { backups: p.backups }), /layout that can't be edited safely/, content);
    assert.equal(await readFile(file, 'utf8'), content);
    assert.notEqual(await configState(p.client(id)), 'installed', content);
  }
  for (const [id, content] of cases) {
    const file = configOf(p.client(id)).path;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    assert.equal(await configState(p.client(id)), 'unusable', content);
    await assert.rejects(installClient(p.client(id), SERVER, { backups: p.backups }), /more than once/, content);
    await assert.rejects(removeClient(p.client(id), { backups: p.backups }), /more than once/, content);
    assert.equal(await readFile(file, 'utf8'), content);
  }
  // A repeated key somewhere else is the user's business.
  const file = configOf(p.client('claude-code')).path;
  await writeFile(file, '{ "theme": "a", "theme": "b", "mcpServers": {} }\n');
  await installClient(p.client('claude-code'), SERVER);
  assert.equal(await configState(p.client('claude-code')), 'installed');
});

test('a config that is not UTF-8 text is refused instead of being rewritten with replacement characters', async t => {
  const p = await profile(t);
  const cases: [string, Buffer][] = [
    ['cursor', Buffer.concat([Buffer.from('{ "note": "caf'), Buffer.from([0xe9]), Buffer.from('", "mcpServers": {} }\n')])],
    ['codex', Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\nmodel = "x"\n')])],
    ['goose', Buffer.concat([Buffer.from('extensions:\n  # caf'), Buffer.from([0xe9]), Buffer.from('\n')])],
  ];
  for (const [id, bytes] of cases) {
    const file = configOf(p.client(id)).path;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    assert.equal(await configState(p.client(id)), 'unusable', id);
    assert.equal(await installedCommand(p.client(id)), undefined);
    await assert.rejects(installClient(p.client(id), SERVER, { backups: p.backups }), /is not UTF-8 text/, id);
    await assert.rejects(removeClient(p.client(id), { backups: p.backups }), /is not UTF-8 text/, id);
    assert.deepEqual(await readFile(file), bytes);
  }
  await assert.rejects(readdir(p.backups), { code: 'ENOENT' });
});

test('removing from a file that never held the entry writes nothing', async t => {
  const p = await profile(t), original = await p.place('zed', 'zed-settings.json');
  await removeClient(p.client('zed'), { backups: p.backups });
  assert.equal(await p.text('zed'), original);
  await assert.rejects(readdir(p.backups), { code: 'ENOENT' });
});

test('edits go through a linked config to the file it points at', async t => {
  const p = await profile(t), dotfiles = path.join(p.home, 'dotfiles'), real = path.join(dotfiles, 'claude.json');
  await mkdir(dotfiles);
  await writeFile(real, '{}\n');
  await symlink(real, path.join(p.home, '.claude.json'));
  await installClient(p.client('claude-code'), SERVER);
  assert.deepEqual(JSON.parse(await readFile(real, 'utf8')), { mcpServers: { clop: { command: SERVER.command, args: SERVER.args } } });
});

test('detection: a config or a known folder means the client is on this PC; empty or flow YAML parents are handled', async t => {
  const p = await profile(t);
  assert.equal(isPresent(p.client('zed')), false);
  await mkdir(path.join(p.folders.localAppData, 'Programs', 'Zed'), { recursive: true });
  assert.equal(isPresent(p.client('zed')), true);
  assert.equal(isPresent(p.client('codex')), false);
  await mkdir(path.join(p.home, '.codex'));
  assert.equal(isPresent(p.client('codex')), true);
  const file = configOf(p.client('goose')).path;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'extensions: {}\nGOOSE_MODE: auto\n');
  await installClient(p.client('goose'), SERVER);
  assert.match(await readFile(file, 'utf8'), /^extensions:\n {2}clop:\n {4}enabled: true\n[\s\S]*timeout: 300\nGOOSE_MODE: auto\n$/);
  await removeClient(p.client('goose'));
  assert.equal(await readFile(file, 'utf8'), 'GOOSE_MODE: auto\n');
});

test('repair repoints entries whose clop.exe is gone, and leaves working ones alone', async t => {
  const p = await profile(t), exe = path.join(p.home, 'Clop', 'cli', 'clop.exe'), other = path.join(p.home, 'Other', 'clop.exe');
  await mkdir(path.dirname(exe), { recursive: true }); await writeFile(exe, '');
  await mkdir(path.dirname(other), { recursive: true }); await writeFile(other, '');
  const current = { command: exe, args: SERVER.args };
  await installClient(p.client('cursor'), { command: path.join(p.home, 'gone', 'clop.exe'), args: SERVER.args });
  await installClient(p.client('codex'), { command: other, args: SERVER.args });
  // Only a command that is an absolute path to something missing is broken: `clop` on PATH, a `cmd /c` wrapper or an argument is the user's own.
  assert.equal(entryIsBroken({ command: path.join(p.home, 'gone', 'clop.exe'), args: SERVER.args }), true);
  assert.equal(entryIsBroken({ command: other, args: ['mcp', path.join(p.home, 'missing.py')] }), false);
  assert.equal(entryIsBroken({ command: 'clop', args: SERVER.args }), false);
  assert.equal(entryIsBroken({ command: 'cmd', args: ['/c', path.join(p.home, 'gone', 'clop.exe'), ...SERVER.args] }), false);
  assert.deepEqual(await repairClients(p.clients, current), ['Cursor']);
  assert.deepEqual(await installedCommand(p.client('cursor')), current);
  assert.deepEqual(await installedCommand(p.client('codex')), { command: other, args: SERVER.args });
  assert.equal(cliCommand(SERVER), 'claude mcp add --scope user clop -- "C:\\Program Files\\Clop for Windows\\cli\\clop.exe" mcp serve');
});

test('every client has an id, a Windows path and an evidence list, and the featured ones come first as on macOS', async t => {
  const p = await profile(t);
  assert.deepEqual(p.clients.map(c => c.id), ['claude-code', 'claude-desktop', 'codex', 'copilot', 'pi', 'opencode', 'gemini', 'antigravity', 'amp', 'droid', 'goose', 'crush', 'qwen', 'kimi', 'devin', 'cursor', 'vscode', 'vscode-insiders', 'zed']);
  assert.deepEqual(p.clients.filter(c => c.featured).map(c => c.name), ['Claude Code', 'Claude Desktop', 'Codex', 'Copilot CLI', 'pi', 'OpenCode', 'Gemini CLI']);
  const styles = new Set(p.clients.flatMap((c: Client) => c.configs.map(config => config.style)));
  assert.deepEqual([...styles].sort(), ['amp', 'codex', 'copilot', 'crushJSON', 'crushrc', 'droid', 'goose', 'mcpServers', 'openCode', 'vsCode', 'zed']);
  for (const c of p.clients) for (const config of c.configs) assert.ok(config.path.startsWith(p.home), config.path);
});

test('the server card names the app, clop.exe and the switch, in the app data folder and .well-known', async t => {
  const p = await profile(t), files = cardPaths(path.join(p.home, 'data'), p.home);
  await writeServerCard(files, { version: '1.2.3', appPath: 'C:\\Clop\\Clop for Windows.exe', enabled: true, cliPath: SERVER.command });
  for (const file of files) {
    const card = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(card.transport, { type: 'stdio', command: SERVER.command, args: ['mcp', 'serve'] });
    assert.equal(card.enabled, true);
    assert.equal(card.control.start, 'cmd /c start clop://mcp/start');
    assert.equal(card.app.path, 'C:\\Clop\\Clop for Windows.exe');
  }
  assert.equal(files[1], path.join(p.home, '.well-known', 'mcp', 'clop.json'));
});
