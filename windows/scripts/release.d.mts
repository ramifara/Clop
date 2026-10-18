export interface UpdateInfo { version: string; files: { url: string; sha512: string; size: number }[]; path: string; sha512: string; releaseDate?: string }
export function readUpdateInfo(text: string): UpdateInfo;
export function mergeUpdateInfo(texts: string[], version: string): string;
export function releaseNotes(changelog: string, version: string): string;
export function versionOfTag(tag: string, packageVersion: string): string;
