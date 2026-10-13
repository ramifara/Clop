export function withLongPathAware(xml: string): string;
export function inspectManifest(xml: string): { applications: number; longPathAware: string[] };
export function isLongPathAware(xml: string): boolean;
export function hasLongPathAware(file: string): Promise<boolean>;
export function setLongPathAware(file: string): Promise<boolean>;
declare function afterPack(context: { electronPlatformName: string; appOutDir: string; packager: { appInfo: { productFilename: string } } }): Promise<void>;
export default afterPack;
