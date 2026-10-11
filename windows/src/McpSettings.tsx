import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { ClopSettings, McpClientRow, McpRequest, McpState } from './types';

// The MCP section of Settings (Clop/MCPSettingsPane.swift): the two switches, the agents Clop's server can be installed
// into, and the command for installing it by hand.

const clean = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);

export function McpSettings({ settings }: { settings: ClopSettings }) {
  const [state, setState] = useState<McpState>();
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [copied, setCopied] = useState<'command' | 'server'>();
  const send = useCallback(async (request: McpRequest) => {
    setError('');
    try { setState(await api.mcp(request)); } catch (failure) { setError(clean(failure)); }
  }, []);
  // Agents are installed and removed outside Clop too, so the list is read again whenever the window comes back.
  useEffect(() => {
    void send({ action: 'state' });
    const refresh = () => void send({ action: 'state' });
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [send]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(undefined), 1200); return () => clearTimeout(timer); }, [copied]);

  const row = (client: McpClientRow) => <div className="mcp-client" key={client.id}>
    <div><strong>{client.name}</strong><small className={client.failed ? 'failed' : ''} title={client.detail}>{client.detail}</small></div>
    {client.state === 'installed' ? <button className="remove" onClick={() => void send({ action: 'remove', id: client.id })}>Remove</button>
      // Nothing to write into: the only move left is to open the file.
      : client.state === 'unusable' ? <button onClick={() => void send({ action: 'reveal', id: client.id })}>Show file</button>
      : <button disabled={!!state?.missing} title={state?.missing} onClick={() => void send({ action: 'install', id: client.id })}>Install</button>}
  </div>;
  const copyRow = (what: 'command' | 'server', title: string, value?: string) => value && <div className="mcp-copy" key={what}>
    <strong>{title}</strong>
    <button title="Copies the line" onClick={() => { setCopied(what); void send({ action: 'copy', what }); }}>{copied === what ? 'Copied!' : value}</button>
  </div>;

  return <section className="mcp-settings" aria-label="MCP">
    <h2>MCP</h2>
    <label className="preference-row"><span>Enable MCP<small>Allow agents to control Clop, run file optimisations, change settings, write pipelines</small></span><input type="checkbox" checked={settings.mcpEnabled} onChange={event => void send({ action: 'enable', on: event.target.checked })}/></label>
    <label className="preference-row"><span>Allow agents to write arbitrary scripts in pipelines<small>Using scripts in pipelines allows for flexible operations but can be dangerous if not properly verified</small></span><input type="checkbox" disabled={!settings.mcpEnabled} checked={settings.mcpAllowScriptSteps} onChange={event => void send({ action: 'scripts', on: event.target.checked })}/></label>
    <h2>Install in</h2>
    {state?.clients.filter(client => client.featured).map(row)}
    <button className="mcp-more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'See less' : 'See more'}</button>
    {more && state?.clients.filter(client => !client.featured).map(row)}
    <h2>Install by hand</h2>
    {state?.missing ? <p>{state.missing}</p> : <>{copyRow('command', 'Command line', state?.command)}{copyRow('server', 'Server', state?.server)}</>}
    {error && <p className="mcp-error" role="alert">{error}</p>}
  </section>;
}
