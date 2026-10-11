import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppState, ClopApi } from '../src/types';
const invoke = (action: string, ...args: unknown[]) => ipcRenderer.invoke('clop:action', action, ...args);
const api: ClopApi = {
  state: () => invoke('state'),
  subscribe: callback => {
    const listener = (_event: unknown, state: AppState) => callback(state);
    ipcRenderer.on('clop:state', listener);
    return () => { ipcRenderer.removeListener('clop:state', listener); };
  },
  importFiles: (files, aggressive) => invoke('import', files.map(file => webUtils.getPathForFile(file)).filter(Boolean), aggressive),
  importUrl: (url, aggressive) => invoke('import-url', url, aggressive),
  clipboard: () => invoke('clipboard'),
  apply: (id, options) => invoke('apply', id, options), restore: id => invoke('restore', id),
  copy: id => invoke('copy', id), save: id => invoke('save', id), reveal: id => invoke('reveal', id),
  drag: id => ipcRenderer.send('clop:drag', id), dismiss: id => invoke('dismiss', id),
  settings: settings => invoke('settings', settings), window: action => invoke('window', action), apps: () => invoke('apps'), mcp: request => invoke('mcp', request),
  pipelines: id => invoke('pipelines', id), runPipeline: (id, pipelineId) => invoke('run-pipeline', id, pipelineId),
  openCrop: id => invoke('open-crop', id), openCompare: id => invoke('open-compare', id),
  cropSource: (id, view) => invoke('crop-source', id, view), crop: (id, request) => invoke('crop', id, request),
  cropSizes: () => invoke('crop-sizes'), saveCropSizes: sizes => invoke('save-crop-sizes', sizes),
  compareSources: (id, view) => invoke('compare-sources', id, view),
  runPreset: (zoneId, files) => invoke('run-preset', zoneId, files.map(file => webUtils.getPathForFile(file)).filter(Boolean)),
  editor: {
    state: () => ipcRenderer.invoke('clop:editor', 'state'), command: command => ipcRenderer.invoke('clop:editor', 'command', command),
    subscribe: callback => {
      const changed = () => callback('changed'), tab = (_event: unknown, name: string) => { if (name === 'zones') callback('zones'); };
      ipcRenderer.on('clop:editor-changed', changed); ipcRenderer.on('clop:editor-tab', tab);
      return () => { ipcRenderer.removeListener('clop:editor-changed', changed); ipcRenderer.removeListener('clop:editor-tab', tab); };
    },
  },
};
contextBridge.exposeInMainWorld('clop', api);
