import type { ClopSettings } from '../core/settings/schema';
export type OutputFormat = 'auto' | 'png' | 'jpeg' | 'webp' | 'avif' | 'gif';
export interface ImageOptions { mode: 'balanced' | 'aggressive' | 'lossless'; scale: number; maxEdge?: number; format: OutputFormat }
export interface ImageResult {
  id: string; name: string; source: 'clipboard' | 'drop' | 'file' | 'sample'; status: 'processing' | 'ready' | 'error';
  originalBytes: number; outputBytes: number; originalWidth: number; originalHeight: number;
  width: number; height: number; format: string; originalPreview: string; preview: string;
  options: ImageOptions; error?: string; unchanged?: boolean; restored?: boolean; animated: boolean; createdAt: number;
}
export type { ClopSettings };
export interface AppState { items: ImageResult[]; settings: ClopSettings; native: boolean; platform: string; dropActive?: boolean; notice?: string }
export interface ClopApi {
  state(): Promise<AppState>; subscribe(callback: (state: AppState) => void): () => void;
  importFiles(files: File[], aggressive?: boolean): Promise<void>; importUrl(url: string, aggressive?: boolean): Promise<void>; clipboard(): Promise<void>;
  apply(id: string, options: ImageOptions): Promise<void>; restore(id: string): Promise<void>;
  copy(id: string): Promise<void>; save(id: string): Promise<void>; reveal(id: string): Promise<void>;
  drag(id: string): void; dismiss(id: string): Promise<void>; settings(settings: Partial<ClopSettings>): Promise<void>;
  window(action: 'hide' | 'main' | 'float' | 'quit' | 'minimize' | 'interactive' | 'passthrough' | 'dismiss-notice'): Promise<void>;
}
declare global { interface Window { clop?: ClopApi } }
