import assert from 'node:assert/strict';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fileURL } from '../core/ipc/protocol';
import { graphic } from '../core/media/image.fixtures';
import { needTools } from '../core/testing';
import { DECLINED_PREFIX, INSTRUCTIONS, SMALLER_OPTIONS_TEXT } from './mcp-copy';
import { connect, folder } from './mcp.fixtures';
import { TOOLS } from './mcp-table';
import { annotate, speedSteps, withFrames } from './mcp-tools';

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
  assert.equal(refused.text, 'Clop is not accepting changes from agents. Ask the user to allow it in Clop Settings, MCP.', 'the refusal already says what to do, once');
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
  assert.match(refused.text, /^Clop is not accepting script steps from agents, .*ask the user to allow script steps in Clop Settings, MCP\.$/);
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

test('the next step is added to a refusal once, and never to a message that already says to ask the user', () => {
  const refusal = 'Clop is not accepting changes from agents.';
  assert.match(annotate(refusal), /^Clop is not accepting changes from agents\. Ask the user to allow agent changes in Clop Settings, MCP, or call clop_start_server/);
  assert.equal(annotate(`${refusal} Ask the user to allow it in Clop Settings, MCP.`), `${refusal} Ask the user to allow it in Clop Settings, MCP.`);
  assert.equal(annotate(annotate(refusal)), annotate(refusal));
  assert.equal(annotate('Script steps are off. Ask the user to allow script steps.'), 'Script steps are off. Ask the user to allow script steps.');
});

test('a refusal before a question reads once', async t => {
  const f = await folder(t);
  await graphic(40, 30).png().toFile(f.file('a.png'));
  const { call } = await connect(t, f);
  const refused = await call('clop_optimise', { paths: ['a.png'] });
  assert.equal(refused.error, true);
  assert.equal(refused.text.match(/Ask the user/g)?.length, 1, refused.text);
});

test('video speed-ups get frames: keep or drop written into each changeSpeed step that has none', () => {
  assert.equal(withFrames('changeSpeed(factor: 2) -> optimise()', 'drop'), 'changeSpeed(factor: 2, frames: drop) -> optimise()');
  assert.equal(withFrames('changeSpeed( factor: 2 ) -> changeSpeed(factor: 0.5) -> changeSpeed()', 'keep'), 'changeSpeed( factor: 2, frames: keep ) -> changeSpeed(factor: 0.5) -> changeSpeed(frames: keep)');
  assert.equal(withFrames('changeSpeed(factor: 3, frames: keep)', 'drop'), 'changeSpeed(factor: 3, frames: keep)');
  assert.equal(speedSteps('runScript(code: "changeSpeed(factor: 2)")').length, 0, 'quoted text is never rewritten');
});

test('start and stop open only the app Clop itself runs, never a program a card names', async t => {
  if (process.platform === 'win32') return t.skip('runs a shell script as the app');
  const f = await folder(t);
  const marker = (name: string) => f.file(name), script = (name: string) => `#!/bin/sh\necho "$1" > "${marker(name)}.ran"\n`;
  const evil = f.file('evil.exe'), real = f.file('Clop for Windows.exe'), notExe = f.file('tool.sh');
  for (const [file, name] of [[evil, 'evil'], [real, 'real'], [notExe, 'tool']] as const) { await writeFile(file, script(name)); await chmod(file, 0o755); }
  const card = (app: string) => writeFile(path.join(f.userData, 'mcp.json'), JSON.stringify({ app: { path: app } }));
  const ran = (name: string) => readFile(`${marker(name)}.ran`, 'utf8').then(text => text.trim(), () => undefined);
  const { call } = await connect(t, f, { extra: { openURL: undefined, appExecutables: [real, notExe] } });
  await card(evil);
  const refused = await call('clop_stop_server');
  assert.equal(refused.error, true);
  assert.match(refused.text, /names no app/);
  await card(notExe);
  assert.equal((await call('clop_stop_server')).error, true, 'an app has to be an .exe');
  await card(real);
  assert.equal((await call('clop_stop_server')).error, false);
  for (let i = 0; i < 50 && !await ran('real'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await ran('real'), 'clop://mcp/stop');
  assert.equal(await ran('evil'), undefined, 'the card cannot make Clop start a program');
  assert.equal(await ran('tool'), undefined);
});
