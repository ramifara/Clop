import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useSettings } from './settings/context';
import { Switch } from './settings/inputs';
import type { McpClientRow, McpRequest, McpState } from './types';

// The MCP tab of Settings (Clop/MCPSettingsPane.swift): the two switches, the agents Clop's server can be installed
// into, and the command for installing it by hand.

const clean = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);

/** One of the two MCP switches. Turning scripts on asks first, in the main process. */
export function McpSwitch({ which }: { which: 'enable' | 'scripts' }) {
  const { settings, run } = useSettings();
  const on = which === 'enable' ? settings.mcpEnabled : settings.mcpAllowScriptSteps;
  return <Switch label={which === 'enable' ? 'Accept changes from agents' : 'Allow agents to write script steps'} checked={on} disabled={which === 'scripts' && !settings.mcpEnabled} onChange={value => void run(() => api.mcp({ action: which === 'enable' ? 'enable' : 'scripts', on: value }))}/>;
}

/** The agents Clop's MCP server can be installed into, and the command for installing it by hand. */
export function McpInstall() {
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

  return <section className="mcp-settings" aria-label="Install in agents">
    {state?.clients.filter(client => client.featured).map(row)}
    <button className="mcp-more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'See less' : 'See more'}</button>
    {more && state?.clients.filter(client => !client.featured).map(row)}
    <h2>Install by hand</h2>
    {state?.missing ? <p>{state.missing}</p> : <>{copyRow('command', 'Command line', state?.command)}{copyRow('server', 'Server', state?.server)}</>}
    {error && <p className="mcp-error" role="alert">{error}</p>}
  </section>;
}
