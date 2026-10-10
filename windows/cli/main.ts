import { spawn } from 'node:child_process';
import os from 'node:os';
import { ExitCode, helpText, resolve, usage, ValidationError } from './args';
import { backendOptions, connectBackend, type Backend, type BackendOptions } from './backend';
import { setColours } from './colors';
import type { ClopCommand, Context } from './context';
import { convertLegacyCommand, localCommands } from './local';
import { convertAudioCommand, convertImageCommand, convertVideoCommand, cropCommand, downscaleCommand, optimiseCommand } from './optimise';
import { pipelineCommand } from './pipelines';
import type { IO } from './results';
import { logsCommand, mcpCommand, settingsCommand } from './settings';

// `clop` (spec step 25): every command and flag of ClopCLI/main.swift. clop.exe runs this with the app's own Electron in
// Node mode, so it has the app's sharp and tools; work goes to the running app over the pipe, or runs here headless.

export const ROOT: ClopCommand = {
  name: 'clop', abstract: 'Clop: optimise, crop and downscale images, videos, audio files and PDFs',
  subcommands: [
    optimiseCommand, cropCommand, downscaleCommand,
    {
      name: 'convert', abstract: 'Converts images, videos and audio files to other formats.', defaultSubcommand: 'legacy',
      discussion: `Use a type subcommand for the full format list and compression controls:
    clop convert image --to webp photo.png
    clop convert video --to gif screencast.mov
    clop convert audio --to mp3 --bitrate 128 recording.wav

The legacy direct conversion (\`clop convert -f avif|heic|webp -q 60 <images>\`)
keeps working and runs locally without the Clop app.`,
      subcommands: [convertImageCommand, convertVideoCommand, convertAudioCommand, convertLegacyCommand],
    },
    localCommands.cropPdf, localCommands.uncropPdf, localCommands.stripExif, pipelineCommand, settingsCommand, mcpCommand, logsCommand,
  ],
};

export interface MainOptions {
  io?: IO;
  cwd?: string;
  home?: string;
  options?: BackendOptions;
  backend?: () => Promise<Backend>;
  env?: NodeJS.ProcessEnv;
  colours?: boolean;
}

const processIO: IO = { out: text => { process.stdout.write(text); }, err: text => { process.stderr.write(text); }, errTTY: !!process.stderr.isTTY };

/** Runs one `clop` invocation and returns its exit code: 0, 1 for a failure, 64 for a usage error. */
export async function main(argv: readonly string[], overrides: MainOptions = {}): Promise<number> {
  const env = overrides.env ?? process.env, io = overrides.io ?? processIO, options = overrides.options ?? backendOptions(env);
  setColours(overrides.colours ?? !!process.stdout.isTTY);
  let backend: Promise<Backend> | undefined, interrupt: (() => Promise<void>) | undefined;
  const onSignal = () => { void (interrupt?.() ?? Promise.resolve()).catch(() => {}).finally(() => process.exit(130)); };
  const ctx: Context = {
    io, cwd: overrides.cwd ?? process.cwd(), home: overrides.home ?? options.home ?? os.homedir(), options, argv, origin: env.CLOP_ORIGIN || undefined,
    backend: () => backend ??= (overrides.backend?.() ?? connectBackend(options)),
    detach: args => { spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], { detached: true, stdio: 'ignore', env, windowsHide: true }).unref(); },
    onInterrupt: handler => {
      interrupt = handler;
      if (handler) process.on('SIGINT', onSignal).on('SIGTERM', onSignal); else process.off('SIGINT', onSignal).off('SIGTERM', onSignal);
    },
  };
  let path: ClopCommand[] = [ROOT];
  try {
    const resolved = resolve(ROOT, argv);
    path = resolved.path;
    if (resolved.help) { io.out(helpText(path)); return 0; }
    return (await path.at(-1)!.run!(resolved.values, ctx)) ?? 0;
  } catch (error) {
    if (error instanceof ExitCode) return error.code;
    if (error instanceof ValidationError) {
      io.err(`Error: ${error.message}\nUsage: ${usage(path)}\n  See '${path.map(c => c.name).join(' ')} --help' for more information.\n`);
      return 64;
    }
    io.err(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
