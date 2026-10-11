import { parseInvocation, planFor } from '../core/cards/actions';
import type { AppState, ClopApi, EditorReply, EditorState } from './types';
/** An error's message without Electron's IPC prefix. */
export const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);
async function request<T = AppState>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${action}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The image operation failed. Try again.');
  return data;
}
async function post<T>(action: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The settings action failed. Try again.');
  return data;
}
async function importFiles(files: File[], aggressive = false) {
  if (files.length > 20) throw new Error('Drop up to 20 images at a time.');
  for (const file of files) {
    if (file.size > 32 * 1024 * 1024) throw new Error('Use an image smaller than 32 MB in the browser preview.');
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Could not read this image.')); reader.readAsDataURL(file);
    });
    await request('import', { name: file.name, data, aggressive });
  }
}
function download(id: string) { const link = document.createElement('a'); link.href = `/api/output/${id}`; link.download = ''; link.click(); }
const browser: ClopApi = {
  state: () => request('state'),
  subscribe(callback) {
    let active = true, busy = false;
    const timer = setInterval(async () => { if (busy) return; busy = true; try { const state = await request('state'); if (active) callback(state); } catch {} finally { busy = false; } }, 650);
    return () => { active = false; clearInterval(timer); };
  },
  importFiles,
  importUrl: async (url, aggressive) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not download this image. Copy the image instead.');
    const blob = await response.blob();
    await importFiles([new File([blob], new URL(url).pathname.split('/').pop() || 'Image.png', { type: blob.type })], aggressive);
  },
  clipboard: async () => {
    if (!navigator.clipboard?.read) throw new Error('Paste an image with Ctrl+V, or drop an image file here.');
    const items = await navigator.clipboard.read();
    for (const item of items) { const type = item.types.find(t => t.startsWith('image/')); if (type) { await importFiles([new File([await item.getType(type)], 'Clipboard.png', { type })]); return; } }
    throw new Error('Copy an image first, then paste it here.');
  },
  apply: async (id, options) => { await request('apply', { id, options }); },
  restore: async id => { await request('restore', { id }); },
  copy: async id => {
    if (!navigator.clipboard?.write) throw new Error('Clipboard access needs HTTPS. Use Save image in this preview.');
    const response = await fetch(`/api/png/${id}`); if (!response.ok) throw new Error('Could not copy this image.');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await response.blob() })]);
  },
  save: async id => download(id), reveal: async id => download(id), drag: () => {},
  dismiss: async id => { await request('dismiss', { id }); },
  settings: async settings => { await request('settings', settings); },
  apps: async () => [],
  pipelines: async () => [],
  runPipeline: async () => { throw new Error('Pipelines run in the Clop app.'); },
  prefs: request => post('prefs', request),
  mcp: async () => ({ clients: [], missing: 'Installing the MCP server into agents works in the desktop app.' }),
  runPreset: async () => { throw new Error('Preset zones run in the Clop app.'); },
  editor: { state: () => request<EditorState>('editor-state'), command: command => request<EditorReply>('editor-command', command), subscribe: () => () => {} },
  window: async action => { if (action === 'float') window.open('/?floating=1', 'clop-floating', 'width=420,height=660'); else if (action === 'close' && window.opener) window.close(); },
  openCrop: async id => { window.open(`/?crop=${encodeURIComponent(id)}`, `clop-crop-${id}`, 'width=1020,height=660'); },
  openCompare: async id => { window.open(`/?compare=${encodeURIComponent(id)}`, `clop-compare-${id}`, 'width=1100,height=760'); },
  cropSource: (id, view) => request('crop-source', { id, view }),
  crop: async (id, request_) => { await request('crop', { id, request: request_ }); },
  cropSizes: () => request('crop-sizes'),
  saveCropSizes: sizes => request('save-crop-sizes', { sizes }),
  compareSources: (id, view) => request('compare-sources', { id, view }),
  openPreview: async id => { window.open(`/?preview=${encodeURIComponent(id)}`, `clop-preview-${id}`, 'width=900,height=700'); },
  cardMenu: async () => { throw new Error('Right-click menus open in the Clop app.'); },
  // The browser preview can re-optimise, restore, dismiss and download; the other actions need the desktop app.
  cardAction: async (ids, invocation) => {
    const { items } = await request('state');
    for (const id of ids) {
      const item = items.find(entry => entry.id === id);
      if (!item) continue;
      const plan = planFor(item, parseInvocation(item.kind, invocation));
      if (plan.type === 'apply') await request('apply', { id, options: { ...item.options, ...plan.options } });
      else if (plan.type === 'ui' && plan.ui === 'restore') await request('restore', { id });
      else if (plan.type === 'ui' && plan.ui === 'dismiss') await request('dismiss', { id });
      else if (plan.type === 'ui' && ['saveAs', 'reveal'].includes(plan.ui)) download(id);
      else if (plan.type === 'ui' && plan.ui === 'copy') await browser.copy(id);
      else throw new Error('This action works in the Clop app.');
    }
  },
};
export const api = window.clop ?? browser;
