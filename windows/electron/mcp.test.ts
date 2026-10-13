import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { mcpSettings } from './mcp';

async function pane(t: TestContext, { cli = true, confirm = true } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'clop-mcp-pane-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cliPath = path.join(home, 'Clop', 'cli', 'clop.exe'), switches = { mcpEnabled: false, mcpAllowScriptSteps: false }, copied: string[] = [], revealed: string[] = [];
  if (cli) { await mkdir(path.dirname(cliPath), { recursive: true }); await writeFile(cliPath, ''); }
  const settings = mcpSettings({
    userData: path.join(home, 'data'), home, cliPath, missing: 'No clop.exe here.', version: '1.0.0', appPath: path.join(home, 'Clop', 'Clop for Windows.exe'), env: {},
    setSwitches: async values => { Object.assign(switches, values); }, switches: () => switches, confirmScripts: async () => confirm,
    reveal: file => revealed.push(file), copy: text => copied.push(text),
  });
  return { home, cliPath, switches, copied, revealed, settings };
}

test('the renderer names agents by id only: paths, unknown ids and malformed requests are refused', async t => {
  const p = await pane(t);
  for (const bad of [undefined, 'install', { action: 'install', id: 'C:\\Windows\\win.ini' }, { action: 'install', path: '/etc/passwd', id: 'nope' }, { action: 'enable', on: 'yes' }, { action: 'copy', what: 'C:\\x' }, { action: 'write', id: 'zed' }]) {
    await assert.rejects(p.settings.handle(bad), /Choose/, JSON.stringify(bad));
  }
});

test('install and remove from the pane, with the detail line saying where the entry went', async t => {
  const p = await pane(t);
  let state = await p.settings.handle({ action: 'state' });
  assert.equal(state.clients.length, 19);
  assert.deepEqual(state.clients.find(c => c.id === 'cursor'), { id: 'cursor', name: 'Cursor', featured: false, state: 'notInstalled', detail: 'Not installed on this PC.', failed: false });
  state = await p.settings.handle({ action: 'install', id: 'cursor' });
  const file = path.join(p.home, '.cursor', 'mcp.json');
  assert.deepEqual(state.clients.find(c => c.id === 'cursor'), { id: 'cursor', name: 'Cursor', featured: false, state: 'installed', detail: file, failed: false });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).mcpServers.clop, { command: p.cliPath, args: ['mcp', 'serve'] });
  state = await p.settings.handle({ action: 'remove', id: 'cursor' });
  assert.equal(state.clients.find(c => c.id === 'cursor')?.state, 'notInstalled');
  await p.settings.handle({ action: 'copy', what: 'server' });
  assert.deepEqual(p.copied, [`${p.cliPath.includes(' ') ? `"${p.cliPath}"` : p.cliPath} mcp serve`]);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '"not an object"');
  state = await p.settings.handle({ action: 'install', id: 'cursor' });
  assert.deepEqual(state.clients.find(c => c.id === 'cursor'), { id: 'cursor', name: 'Cursor', featured: false, state: 'unusable', detail: `${file} can't be edited safely.`, failed: true });
  await p.settings.handle({ action: 'reveal', id: 'cursor' });
  assert.deepEqual(p.revealed, [file]);
});

test('install checks the file again: one the pane called unusable is never written', async t => {
  const p = await pane(t);
  const file = path.join(p.home, '.cursor', 'mcp.json'), json5 = '{\n  mcpServers: { other: { command: "x" } },\n}\n';
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, json5);
  const state = await p.settings.handle({ action: 'install', id: 'cursor' });
  assert.deepEqual(state.clients.find(c => c.id === 'cursor'), { id: 'cursor', name: 'Cursor', featured: false, state: 'unusable', detail: `${file} can't be edited safely.`, failed: true });
  assert.equal(await readFile(file, 'utf8'), json5);
});

test('without clop.exe nothing is installed and the pane says why', async t => {
  const p = await pane(t, { cli: false });
  const state = await p.settings.handle({ action: 'install', id: 'zed' });
  assert.equal(state.missing, 'No clop.exe here.');
  assert.equal(state.server, undefined);
  assert.deepEqual(state.clients.find(c => c.id === 'zed'), { id: 'zed', name: 'Zed', featured: false, state: 'notInstalled', detail: 'No clop.exe here.', failed: true });
});

test('the switches: scripts need MCP on and the user to confirm', async t => {
  const p = await pane(t, { confirm: false });
  await assert.rejects(p.settings.handle({ action: 'scripts', on: true }), /Enable MCP first/);
  await p.settings.handle({ action: 'enable', on: true });
  await p.settings.handle({ action: 'scripts', on: true });
  assert.deepEqual(p.switches, { mcpEnabled: true, mcpAllowScriptSteps: false }, 'cancelled in the dialog');
  const yes = await pane(t);
  await yes.settings.handle({ action: 'enable', on: true });
  await yes.settings.handle({ action: 'scripts', on: true });
  assert.deepEqual(yes.switches, { mcpEnabled: true, mcpAllowScriptSteps: true });
  await yes.settings.writeCard();
  const card = JSON.parse(await readFile(path.join(yes.home, 'data', 'mcp.json'), 'utf8'));
  assert.equal(card.enabled, true);
  assert.equal(card.transport.command, yes.cliPath);
});
