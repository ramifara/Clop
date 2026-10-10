import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { BatchApi, BatchViewState } from '../src/batch/types';
const invoke = (action: string, ...args: unknown[]) => ipcRenderer.invoke('clop:batch', action, ...args);
const api: BatchApi = {
  state: () => invoke('state'),
  subscribe: callback => {
    const listener = (_event: unknown, state: BatchViewState) => callback(state);
    ipcRenderer.on('clop:batch-state', listener);
    return () => { ipcRenderer.removeListener('clop:batch-state', listener); };
  },
  add: files => invoke('add', files.map(file => webUtils.getPathForFile(file)).filter(Boolean)),
  start: (files, params) => invoke('start', { files, params }),
  cancel: id => invoke('cancel', id), revert: id => invoke('revert', id), deleteBackups: id => invoke('delete-backups', id),
  failures: id => invoke('failures', id), reveal: file => invoke('reveal', file), chooseFolder: () => invoke('choose-folder'),
  clear: () => invoke('clear'), close: () => invoke('close'),
};
contextBridge.exposeInMainWorld('clopBatch', api);
