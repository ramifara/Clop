import assert from 'node:assert/strict';
import test from 'node:test';
import { clopURLs, linkInbox, MCP_START_QUESTION, parseClopURL, settingsTab } from './clop-url';

test('settings links name a tab, a row, or both, as SettingsURL.swift reads them', () => {
  assert.deepEqual(parseClopURL('clop://settings/video'), { kind: 'settings', tab: 'video' });
  assert.deepEqual(parseClopURL('clop://settings/video/'), { kind: 'settings', tab: 'video' });
  assert.deepEqual(parseClopURL('clop://settings/Preset%20zones/onlyShowPresetZonesOnControlTapped'), { kind: 'settings', tab: 'presetZones', row: 'onlyShowPresetZonesOnControlTapped' });
  assert.deepEqual(parseClopURL('clop://settings/stripMetadata'), { kind: 'settings', row: 'stripMetadata' }, 'a first part that is no tab is the row');
  assert.deepEqual(parseClopURL('clop://settings/images?highlight=imageCompression'), { kind: 'settings', tab: 'images', row: 'imageCompression' });
  assert.deepEqual(parseClopURL('clop://settings'), { kind: 'settings' });
  assert.equal(settingsTab('Keyboard-Shortcuts'), 'keys');
  assert.equal(settingsTab('licenseUpdates'), 'updates');
  assert.equal(settingsTab('nowhere'), undefined);
});

test('mcp links start or stop the MCP switch; anything else is not ours', () => {
  assert.deepEqual(parseClopURL('clop://mcp/start'), { kind: 'mcp', action: 'start' });
  assert.deepEqual(parseClopURL('CLOP://mcp/stop'), { kind: 'mcp', action: 'stop' });
  assert.equal(parseClopURL('clop://mcp/restart'), undefined);
  assert.equal(parseClopURL('clop://batch/open'), undefined);
  assert.equal(parseClopURL('https://settings/video'), undefined);
  assert.equal(parseClopURL('not a url'), undefined);
});

test('links are picked out of a second instance\'s arguments', () => {
  assert.deepEqual(clopURLs(['C:\\Clop\\Clop for Windows.exe', '--hidden', 'clop://settings/pdf', 'C:\\a.png', 'clop://mcp/stop']), [{ kind: 'settings', tab: 'pdf' }, { kind: 'mcp', action: 'stop' }]);
});

test('links that arrive while the app starts are opened in order once it is ready', () => {
  const opened: string[] = [], inbox = linkInbox(link => opened.push(link.kind === 'mcp' ? link.action : 'settings'));
  inbox.receive(clopURLs(['clop://mcp/stop']));
  inbox.receive(clopURLs(['clop://settings/pdf']));
  assert.deepEqual(opened, []);
  inbox.ready();
  assert.deepEqual(opened, ['stop', 'settings']);
  inbox.receive(clopURLs(['clop://mcp/start']));
  assert.deepEqual(opened, ['stop', 'settings', 'start']);
});

test('the start question does not say an agent asked, since any website or app can open the link', () => {
  assert.equal(MCP_START_QUESTION.message, 'Let AI agents change files and settings through Clop?');
  assert.doesNotMatch(MCP_START_QUESTION.detail, /^An agent asked/);
  assert.match(MCP_START_QUESTION.detail, /possibly a website or another app\. Allow it only if you asked an agent to use Clop just now\./);
});
