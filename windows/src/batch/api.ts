import { DEFAULT_CROP_SIZES } from '../../core/data/cropSizes';
import type { BatchApi, BatchViewState } from './types';

// The browser preview has no files to optimise, so it shows a sample batch: prepared files that "Optimise" turns into finished rows.
const sample = (name: string, kind: 'image' | 'video' | 'pdf' | 'audio', bytes: number) => ({ path: `C:\\Users\\You\\Pictures\\Trip\\${name}`, kind, bytes, format: name.split('.').pop()!.toUpperCase() });
const files = [
  sample('beach.jpg', 'image', 4_820_000), sample('harbour.png', 'image', 9_310_000), sample('sunset.heic', 'image', 2_640_000), sample('drone.mp4', 'video', 186_000_000),
  sample('tickets.pdf', 'pdf', 3_200_000), sample('voice-note.m4a', 'audio', 5_100_000), sample('map.webp', 'image', 1_240_000),
];
const defaults: BatchViewState['defaults'] = {
  output: { location: 'inPlace' },
  image: { compression: 30, adaptive: false, allowLarger: true },
  video: { compression: 50, encoder: 'fast', fps: 60, removeAudio: false, allowLarger: true },
  pdf: { dpi: 'adaptive' },
  audio: { compression: 35, convertLossless: false, coverArt: 'optimise', coverArtSquaring: 'landscapeOnly', allowLarger: true },
};
let state: BatchViewState = {
  files, scanning: false, notices: [], defaults, cropSizes: [...DEFAULT_CROP_SIZES], native: false,
  audioFormats: [
    { format: 'aac', name: 'AAC (M4A)', lossless: false, coverArt: true, bitrates: { lo: 48, hi: 256 } }, { format: 'mp3', name: 'MP3', lossless: false, coverArt: true, bitrates: { lo: 64, hi: 320 } },
    { format: 'opus', name: 'Opus (OGG)', lossless: false, coverArt: false, bitrates: { lo: 32, hi: 160 } }, { format: 'wav', name: 'WAV', lossless: true, coverArt: false }, { format: 'flac', name: 'FLAC', lossless: true, coverArt: true },
  ],
};
const listeners = new Set<(state: BatchViewState) => void>();
const update = (next: BatchViewState) => { state = next; for (const listener of listeners) listener(state); };
const unavailable = async () => { throw new Error('The browser preview cannot change files. Use the batch optimiser in the desktop app.'); };
const browser: BatchApi = {
  state: async () => state,
  subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  add: unavailable,
  start: async (paths, params) => {
    const sizes: Record<string, [number, number] | undefined> = { 'beach.jpg': [4032, 3024], 'harbour.png': [3840, 2160], 'sunset.heic': [4032, 3024], 'drone.mp4': [3840, 2160], 'map.webp': [2048, 1536] };
    const items = files.filter(file => paths.includes(file.path)).map((file, i) => {
      const name = file.path.split('\\').pop()!, size = sizes[name], old = size && { width: size[0], height: size[1] };
      const failed = name === 'sunset.heic', shrink = [0.31, 0.58, 1, 0.44, 0.62, 0.71, 0.88][i];
      return {
        path: file.path, name, kind: file.kind, oldBytes: file.bytes, oldFormat: file.format, oldSize: old,
        ...(failed ? { status: 'failed' as const, error: 'heif-dec exited with code 1: unsupported HEIF brand' }
          : { status: 'done' as const, result: file.path, newBytes: Math.round(file.bytes * shrink), newFormat: file.format, newSize: old, ...(file.kind === 'pdf' ? { oldDetail: 300, newDetail: 150 } : file.kind === 'audio' ? { oldDetail: 256, newDetail: 160 } : {}) }),
      };
    });
    void params;
    update({ ...state, files: [], batch: { id: '00000000-0000-4000-8000-000000000000', phase: 'finished', items, backups: 'C:\\Users\\You\\AppData\\Roaming\\Clop for Windows\\work\\batch-backups\\batch-sample', backupsDeleted: false } });
  },
  cancel: unavailable,
  revert: async () => { await unavailable(); return []; },
  deleteBackups: unavailable,
  failures: async () => state.batch?.items.filter(item => item.status === 'failed').map(item => ({ path: item.path, name: item.name, error: item.error!, log: `${item.error}\n\nheif-dec: Unsupported feature: Unsupported codec (4.3000)` })) ?? [],
  reveal: unavailable,
  chooseFolder: async () => 'C:\\Users\\You\\Pictures\\Optimised',
  confirmAdd: unavailable, cancelAdd: unavailable, reopen: unavailable,
  clear: async () => update({ ...state, files, batch: undefined }),
  close: async () => {},
};
export const batchApi = window.clopBatch ?? browser;
