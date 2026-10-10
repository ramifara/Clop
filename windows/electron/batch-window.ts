import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { BatchHost, type BatchHostOptions } from './batch';

// BatchWindow.swift: the batch optimiser's window, the same renderer bundle as the other windows with `?batch=1`, sandboxed,
// with its own narrow preload. Requests on `clop:batch` are accepted from this window only.

export interface BatchWindowOptions extends Omit<BatchHostOptions, 'show' | 'publish' | 'reveal'> {
  /** The folder holding `preload-batch.cjs` and, packaged, `../dist/index.html`. */
  here: string;
  devUrl?: string;
  quitting: () => boolean;
}

export function setupBatch(options: BatchWindowOptions) {
  let window: BrowserWindow | undefined;
  const send = () => { if (window && !window.isDestroyed()) window.webContents.send('clop:batch-state', host.state()); };
  const host: BatchHost = new BatchHost({ ...options, show: () => show(), publish: send, reveal: file => shell.showItemInFolder(file) });
  function show() {
    if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
    window = new BrowserWindow({
      width: 1140, height: 720, minWidth: 900, minHeight: 520, show: false, title: 'Batch optimisation', backgroundColor: '#f3f1ef', autoHideMenuBar: true,
      webPreferences: { preload: path.join(options.here, 'preload-batch.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    // Closing hides the window; a running batch carries on and shows again with the next large drop.
    window.on('close', event => { if (!options.quitting()) { event.preventDefault(); window?.hide(); } });
    window.once('ready-to-show', () => window?.show());
    void (options.devUrl ? window.loadURL(`${options.devUrl}/?batch=1`) : window.loadFile(path.join(options.here, '../dist/index.html'), { query: { batch: '1' } }));
  }
  ipcMain.handle('clop:batch', async (event, action: unknown, ...args: unknown[]) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error('Untrusted window.');
    switch (action) {
      case 'state': return host.state();
      case 'add': await host.add(args[0]); return;
      case 'start': await host.start(args[0]); return;
      case 'cancel': host.cancel(args[0]); return;
      case 'revert': return await host.revert(args[0]);
      case 'delete-backups': await host.deleteBackups(args[0]); return;
      case 'failures': return host.failures(args[0]);
      case 'reveal': host.reveal(args[0]); return;
      case 'choose-folder': {
        const result = await dialog.showOpenDialog(window, { title: 'Save results to', properties: ['openDirectory', 'createDirectory'] });
        return result.canceled ? undefined : result.filePaths[0];
      }
      case 'clear': host.clear(); return;
      case 'close': window.hide(); return;
      default: throw new Error('Unknown batch action.');
    }
  });
  return { host, show };
}
