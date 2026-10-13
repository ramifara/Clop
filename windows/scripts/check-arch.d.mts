export const X64_ON_ARM64: string[];
export function machineOf(file: string): Promise<string>;
export function checkArch(arch: string, dir: string): Promise<{ problems: string[]; checked: number }>;
