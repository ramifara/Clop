export type MediaKind = 'image' | 'video' | 'pdf' | 'audio';
export interface MediaJobOptions { aggressive?: boolean; signal?: AbortSignal; onProgress?: (fraction: number) => void }
/** What a media function produced. `unchanged` means the input was kept because the result was not smaller; `path` is then the input. */
export interface MediaOutput { path: string; bytes: number; format: string; width?: number; height?: number; durationMs?: number; pages?: number; unchanged?: boolean }
