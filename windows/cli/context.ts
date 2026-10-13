import type { Command, OptionSpec, Values } from './args';
import type { Backend, BackendOptions } from './backend';
import type { IO } from './results';

/** What every command runs with. Tests pass their own IO, folders and backend. */
export interface Context {
  io: IO;
  cwd: string;
  home: string;
  options: BackendOptions;
  backend(): Promise<Backend>;
  /** `CLOP_ORIGIN`: `mcp` when the MCP server runs the command, which the app's gate checks. */
  origin?: string;
  /** Runs the same command again in a detached process without `--async`, for headless `--async`. */
  detach(argv: string[]): void;
  /** The arguments this command was started with, for `detach`. */
  argv: readonly string[];
  /** Called on Ctrl-C while a request runs. */
  onInterrupt(handler: (() => Promise<void>) | undefined): void;
}

export type ClopCommand = Command<Context>;

export const flag = (name: string, help: string, short?: string, extra: Partial<OptionSpec> = {}): OptionSpec => ({ name, help, kind: 'flag', ...(short ? { short } : {}), ...extra });
export const option = (name: string, help: string, short?: string, extra: Partial<OptionSpec> = {}): OptionSpec => ({ name, help, kind: 'option', ...(short ? { short } : {}), ...extra });

export const str = (values: Values, name: string) => values[name] as string | undefined;
export const list = (values: Values, name: string) => values[name] as string[] | undefined;
export const on = (values: Values, name: string) => values[name] === true;
