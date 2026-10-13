// A small command-line parser with Swift ArgumentParser's conventions, so `clop` takes the same words as on macOS:
// `--kebab-case` names, single-letter short names that combine (`-gcj`), `--name=value`, `--no-` inversions, repeated
// options for lists, `--` to end options, default subcommands, and the same exit codes (64 for a usage error).

export interface OptionSpec {
  /** The parsed value's name; the long name is its kebab case. */
  name: string;
  /** A short name, such as `g` for `-g`. */
  short?: string;
  /** A flag is present or not; an option takes a value; an inversion is `--name` / `--no-name`. */
  kind: 'flag' | 'option' | 'inversion';
  help: string;
  /** Repeated options collect every value (comma-separated values are split too). */
  repeated?: boolean;
  required?: boolean;
  hidden?: boolean;
  /** Extra long names, as in `--gui` for `--show-result`. */
  aliases?: string[];
}
export interface ArgumentSpec { name: string; help: string; variadic?: boolean; required?: boolean }

export type Values = Record<string, string | string[] | boolean | undefined>;
export interface Command<Context = unknown> {
  name: string;
  abstract?: string;
  discussion?: string;
  hidden?: boolean;
  options?: OptionSpec[];
  arguments?: ArgumentSpec[];
  subcommands?: Command<Context>[];
  defaultSubcommand?: string;
  run?: (values: Values, context: Context) => Promise<number | void>;
}

/** A usage error: printed with the usage line, exit code 64. */
export class ValidationError extends Error { override name = 'ValidationError'; }
/** Ends the command with this exit code, printing nothing more. */
export class ExitCode extends Error { constructor(readonly code: number) { super(`exit ${code}`); this.name = 'ExitCode'; } }

export const kebab = (name: string) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const longNames = (option: OptionSpec) => [kebab(option.name), ...(option.aliases ?? [])];

export interface Resolved<Context> { path: Command<Context>[]; values: Values; help: boolean }

/** Walks to the command `argv` names (falling back to default subcommands), then parses that command's options and arguments. */
export function resolve<Context>(root: Command<Context>, argv: readonly string[]): Resolved<Context> {
  const path = [root];
  let rest = [...argv], help = false;
  if (rest[0] === 'help') { help = true; rest = rest.slice(1); }
  for (;;) {
    const current = path.at(-1)!;
    if (!current.subcommands?.length) break;
    const named = current.subcommands.find(command => command.name === rest[0]);
    if (named) { path.push(named); rest = rest.slice(1); continue; }
    const fallback = current.subcommands.find(command => command.name === current.defaultSubcommand);
    // `clop optimise --help` describes `optimise`; `clop optimise a.png` and a bare `clop settings` run the default.
    if (!fallback || help || (rest.length && rest.every(arg => arg === '-h' || arg === '--help'))) break;
    path.push(fallback);
  }
  const command = path.at(-1)!;
  if (help || !command.run) return { path, values: {}, help: true };
  return { path, ...parse(command, rest) };
}

function parse<Context>(command: Command<Context>, argv: string[]): { values: Values; help: boolean } {
  const options = command.options ?? [], values: Values = {}, positionals: string[] = [];
  const byLong = new Map<string, OptionSpec>(), byShort = new Map<string, OptionSpec>();
  for (const option of options) { for (const name of longNames(option)) byLong.set(name, option); if (option.short) byShort.set(option.short, option); }
  for (const option of options) if (option.kind !== 'option') values[option.name] = option.kind === 'flag' ? false : undefined;
  const set = (option: OptionSpec, value: string) => {
    if (!option.repeated) { values[option.name] = value; return; }
    values[option.name] = [...(values[option.name] as string[] | undefined ?? []), ...value.split(',').map(part => part.trim()).filter(Boolean)];
  };
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (arg === '-h' || arg === '--help') { help = true; continue; }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
      const option = byLong.get(name), inverted = !option && name.startsWith('no-') ? byLong.get(name.slice(3)) : undefined;
      if (inverted?.kind === 'inversion') { values[inverted.name] = false; continue; }
      if (!option) throw new ValidationError(`Unknown option '--${name}'`);
      if (option.kind !== 'option') {
        if (inline !== undefined) throw new ValidationError(`The flag '--${name}' does not take a value`);
        values[option.name] = true; continue;
      }
      const value = inline ?? argv[++i];
      if (value === undefined) throw new ValidationError(`Missing value for '--${name} <${kebab(option.name)}>'`);
      set(option, value);
      continue;
    }
    if (arg.length > 1 && arg.startsWith('-') && !/^-\d/.test(arg)) {
      // Combined short flags; an option among them takes the rest of the word or the next argument.
      for (let j = 1; j < arg.length; j++) {
        const option = byShort.get(arg[j]);
        if (!option) throw new ValidationError(`Unknown option '-${arg[j]}'`);
        if (option.kind !== 'option') { values[option.name] = true; continue; }
        const value = arg.slice(j + 1).replace(/^=/, '') || argv[++i];
        if (value === undefined) throw new ValidationError(`Missing value for '-${arg[j]} <${kebab(option.name)}>'`);
        set(option, value);
        break;
      }
      continue;
    }
    positionals.push(arg);
  }
  if (help) return { values, help };
  const specs = command.arguments ?? [];
  for (const spec of specs) {
    if (spec.variadic) { values[spec.name] = positionals.splice(0); continue; }
    const value = positionals.shift();
    if (value === undefined && spec.required !== false) throw new ValidationError(`Missing expected argument '<${kebab(spec.name)}>'`);
    values[spec.name] = value;
  }
  if (positionals.length) throw new ValidationError(`Unexpected argument '${positionals[0]}'`);
  for (const option of options) if (option.required && values[option.name] === undefined) throw new ValidationError(`Missing expected argument '--${kebab(option.name)} <${kebab(option.name)}>'`);
  return { values, help };
}

const optionLabel = (option: OptionSpec) => {
  const long = option.kind === 'inversion' ? `--${kebab(option.name)}/--no-${kebab(option.name)}` : longNames(option).map(name => `--${name}`).join(', ');
  return `${option.short ? `-${option.short}, ` : ''}${long}${option.kind === 'option' ? ` <${kebab(option.name)}>` : ''}`;
};

export function usage<Context>(path: Command<Context>[]): string {
  const command = path.at(-1)!, words = path.map(c => c.name);
  if (!command.run) return `${words.join(' ')} <subcommand>`;
  const options = (command.options ?? []).filter(option => !option.hidden).map(option => {
    const label = option.kind === 'option' ? `--${kebab(option.name)} <${kebab(option.name)}>` : option.kind === 'inversion' ? `--${kebab(option.name)}` : `--${kebab(option.name)}`;
    const shown = option.repeated ? `${label} ...` : label;
    return option.required ? shown : `[${shown}]`;
  });
  const args = (command.arguments ?? []).map(arg => { const label = `<${kebab(arg.name)}>${arg.variadic ? ' ...' : ''}`; return arg.required === false || arg.variadic ? `[${label}]` : label; });
  return [...words, ...options, ...args].join(' ');
}

const wrap = (label: string, help: string) => {
  const lines = help.trim().split('\n');
  const first = label.length < 24 ? `  ${label.padEnd(24)}${lines[0]}` : `  ${label}\n${' '.repeat(26)}${lines[0]}`;
  return [first, ...lines.slice(1).map(line => line ? `${' '.repeat(26)}${line}` : '')].join('\n');
};

/** The `--help` text: overview, usage, arguments, options and subcommands, laid out like ArgumentParser's. */
export function helpText<Context>(path: Command<Context>[]): string {
  const command = path.at(-1)!, parts: string[] = [];
  if (command.abstract) parts.push(`OVERVIEW: ${command.abstract}`);
  if (command.discussion) parts.push(command.discussion.trim());
  parts.push(`USAGE: ${usage(path)}`);
  const args = command.run ? command.arguments ?? [] : [];
  if (args.length) parts.push(['ARGUMENTS:', ...args.map(arg => wrap(`<${kebab(arg.name)}>`, arg.help))].join('\n'));
  const options = (command.run ? command.options ?? [] : []).filter(option => !option.hidden);
  parts.push(['OPTIONS:', ...options.map(option => wrap(optionLabel(option), option.help)), wrap('-h, --help', 'Show help information.')].join('\n'));
  const subcommands = (command.subcommands ?? []).filter(sub => !sub.hidden);
  if (subcommands.length) parts.push(['SUBCOMMANDS:', ...subcommands.map(sub => wrap(`${sub.name}${sub.name === command.defaultSubcommand ? ' (default)' : ''}`, sub.abstract ?? ''))].join('\n'));
  if (subcommands.length) parts.push(`  See '${path.map(c => c.name).join(' ')} help <subcommand>' for detailed help.`);
  return `${parts.join('\n\n')}\n`;
}
