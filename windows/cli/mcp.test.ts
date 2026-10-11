import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type CallToolResult, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { fileURL } from '../core/ipc/protocol';
import { graphic } from '../core/media/image.fixtures';
import { needTools } from '../core/testing';
import { createServer } from './mcp';
import { DECLINED_PREFIX, INSTRUCTIONS, SMALLER_OPTIONS_TEXT } from './mcp-copy';
import { TOOLS } from './mcp-table';
import { speedSteps, withFrames } from './mcp-tools';

/** A folder with an app data folder holding `settings`, and no running app, so every tool runs headless. */
async function folder(t: TestContext, settings: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const userData = path.join(dir, 'data'), file = (name: string) => path.join(dir, name);
  const settle = (values: Record<string, unknown>) => writeFile(path.join(userData, 'settings.json'), JSON.stringify(values));
  await import('node:fs/promises').then(fs => fs.mkdir(userData, { recursive: true }));
  await settle(settings);
  return { dir, userData, file, settle, settings: async () => JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8')) };
}

/** A client connected in memory to a server for `dir`. `answer` answers questions when given; without it the client cannot show one. */
async function connect(t: TestContext, f: Awaited<ReturnType<typeof folder>>, { answer, opened }: { answer?: () => ElicitResult; opened?: string[] } = {}) {
  const server = createServer({ options: { userData: f.userData, home: f.dir }, cwd: f.dir, home: f.dir, env: {}, log: () => {}, startWaitMs: 3000, openURL: async url => { opened?.push(url); if (url.endsWith('start')) await f.settle({ ...await f.settings(), mcpEnabled: true }); } });
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

test('stdio: initialize, 23 tools, and clop_optimise headless on a file', async t => {
  if (!needTools(t, 'pngquant')) return;
  const f = await folder(t, { mcpEnabled: true });
  await graphic(400, 300).png({ compressionLevel: 0 }).toFile(f.file('a.png'));
  const before = (await stat(f.file('a.png'))).size;
  const tsx = path.join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, path.join(import.meta.dirname, 'index.ts'), 'mcp', 'serve'], env: { ...process.env, CLOP_USER_DATA: f.userData } as Record<string, string>, cwd: f.dir, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual(client.getServerVersion(), { name: 'clop-mcp', version: '2.0.0' });
  assert.equal(client.getInstructions(), INSTRUCTIONS);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 23);
  assert.deepEqual(tools.map(tool => tool.name), TOOLS.map(tool => tool.name));
  assert.deepEqual(tools.find(tool => tool.name === 'clop_crop')?.inputSchema.required, ['paths', 'size']);
  const result = await client.callTool({ name: 'clop_optimise', arguments: { paths: [f.file('a.png')], smallerBy: 'compression' } }) as CallToolResult;
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const json = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(json.done.length, 1);
  assert.equal(json.done[0].forURL, fileURL(f.file('a.png')));
  assert.ok(json.done[0].newBytes < before, 'the file was optimised');
  assert.ok((await stat(f.file('a.png'))).size < before);
});

test('the gate: agents are refused until the user allows them, and can never flip the switches', async t => {
  const f = await folder(t);
  await graphic(40, 30).png().toFile(f.file('a.png'));
  const { call } = await connect(t, f);
  const refused = await call('clop_optimise', { paths: ['a.png'], compression: '60' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /^Clop is not accepting changes from agents\. .* or call clop_start_server, which puts that question on screen for them\.$/);
  const set = await call('clop_settings_set', { key: 'stripMetadata', value: 'false' });
  assert.equal(set.error, true);
  assert.match(set.text, /not accepting changes from agents/);
  const read = JSON.parse((await call('clop_settings_get', { key: 'stripMetadata' })).text);
  assert.equal(read.settings[0].key, 'stripMetadata', 'reading works with the switch off');
  await f.settle({ mcpEnabled: true });
  const own = await call('clop_settings_set', { key: 'mcpAllowScriptSteps', value: 'true' });
  assert.equal(own.error, true);
  assert.match(own.text, /mcpAllowScriptSteps can only be changed by the user, in Clop Settings\./);
  const changed = JSON.parse((await call('clop_settings_set', { key: 'stripMetadata', value: 'false' })).text);
  assert.equal(changed.settings[0].value, 'false');
  assert.equal((await f.settings()).stripMetadata, false);
  assert.equal((await call('clop_debug_logs', { action: 'status' })).text, 'Debug logs for Clop are not kept');
});

test('mcpAllowScriptSteps: a pipeline with a script step is refused until the user allows script steps', async t => {
  const f = await folder(t, { mcpEnabled: true });
  const { call } = await connect(t, f);
  const steps = 'runScript(code: "echo hi") -> optimise()';
  const refused = await call('clop_pipeline_write', { name: 'echo', steps });
  assert.equal(refused.error, true);
  assert.match(refused.text, /not accepting script steps from agents.*Script steps are behind their own switch\. Ask the user to allow them in Clop Settings, MCP\./s);
  await graphic(40, 30).png().toFile(f.file('a.png'));
  const run = await call('clop_pipeline_run', { pipeline: steps, paths: [f.file('a.png')] });
  assert.equal(run.error, true);
  assert.match(run.text, /script steps/);
  assert.equal((await f.settings()).pipelines, undefined, 'nothing was saved');
  assert.equal((await call('clop_pipeline_write', { name: 'plain', steps: 'optimise()' })).error, false, 'built-in steps are fine');
  await f.settle({ ...await f.settings(), mcpAllowScriptSteps: true });
  const allowed = await call('clop_pipeline_write', { name: 'echo', steps });
  assert.equal(allowed.error, false, allowed.text);
  const shown = JSON.parse((await call('clop_pipeline_show', { name: 'echo' })).text);
  assert.match(JSON.stringify(shown), /runScript/);
});

test('questions: "make it smaller" asks the user, and without a way to ask returns the options as text', async t => {
  if (!needTools(t, 'pngquant')) return;
  const f = await folder(t, { mcpEnabled: true });
  await graphic(400, 300).png({ compressionLevel: 0 }).toFile(f.file('a.png'));
  const before = (await stat(f.file('a.png'))).size;
  const plain = await connect(t, f);
  assert.deepEqual(await plain.call('clop_optimise', { paths: ['a.png'] }), { error: false, text: SMALLER_OPTIONS_TEXT });
  assert.equal((await stat(f.file('a.png'))).size, before, 'nothing ran');
  const declining = await connect(t, f, { answer: () => ({ action: 'decline' }) });
  assert.equal((await declining.call('clop_optimise', { paths: ['a.png'] })).text, DECLINED_PREFIX + SMALLER_OPTIONS_TEXT);
  assert.match((await declining.call('clop_optimise', { paths: ['nope.png'] })).text, /^not found: nope\.png$/, 'a missing file is refused before asking');
  const asked: string[] = [];
  const answering = await connect(t, f, { answer: () => { asked.push('smaller'); return { action: 'accept', content: { target: 'both', compression: 80 } }; } });
  const done = await answering.call('clop_optimise', { paths: ['a.png'] });
  assert.equal(done.error, false, done.text);
  assert.deepEqual(asked, ['smaller']);
  const result = JSON.parse(done.text).done[0];
  assert.deepEqual(result.newWidthHeight, [200, 150], 'both: downscaled by half and compressed');
});

test('arguments: required ones are named, unknown tools are refused, start and stop open clop:// links', async t => {
  const f = await folder(t);
  const opened: string[] = [];
  const { call } = await connect(t, f, { opened });
  assert.deepEqual(await call('clop_convert', { paths: ['a.png'], kind: 'image' }), { error: true, text: 'clop_convert needs to' });
  assert.deepEqual(await call('clop_crop', { paths: [] }), { error: true, text: 'clop_crop needs paths, size' });
  assert.deepEqual(await call('clop_nope'), { error: true, text: 'unknown tool: clop_nope' });
  assert.deepEqual(await call('clop_convert', { paths: ['a.png'], kind: 'pdf', to: 'png' }), { error: true, text: 'kind must be image, video or audio' });
  assert.equal(JSON.parse((await call('clop_stop_server')).text).stopped, true);
  await writeFile(path.join(f.userData, 'mcp.json'), JSON.stringify({ version: '9.9', displayName: 'Clop' }));
  const started = JSON.parse((await call('clop_start_server')).text);
  assert.deepEqual(opened, ['clop://mcp/stop', 'clop://mcp/start']);
  assert.equal(started.mcp.enabled, true);
  assert.equal(started.version, '9.9', 'status carries the card');
  assert.match((await call('clop_pipeline_prompt', { compact: true })).text, /changeSpeed/);
  const pdf = await call('clop_crop_pdf', { paths: ['x.pdf'], forDevice: 'Nokia 3310' });
  assert.equal(pdf.error, true);
  assert.match(pdf.text, /^Unknown device "Nokia 3310"\.\n\n/, 'the listing replaces the pointer at a flag');
});

test('video speed-ups get frames: keep or drop written into each changeSpeed step that has none', () => {
  assert.equal(withFrames('changeSpeed(factor: 2) -> optimise()', 'drop'), 'changeSpeed(factor: 2, frames: drop) -> optimise()');
  assert.equal(withFrames('changeSpeed( factor: 2 ) -> changeSpeed(factor: 0.5) -> changeSpeed()', 'keep'), 'changeSpeed( factor: 2, frames: keep ) -> changeSpeed(factor: 0.5) -> changeSpeed(frames: keep)');
  assert.equal(withFrames('changeSpeed(factor: 3, frames: keep)', 'drop'), 'changeSpeed(factor: 3, frames: keep)');
  assert.equal(speedSteps('runScript(code: "changeSpeed(factor: 2)")').length, 0, 'quoted text is never rewritten');
});
