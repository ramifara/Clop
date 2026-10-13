// Port of ClopCLI/Colorize.swift: styles wrap a string in ANSI codes, re-opening the style after any reset inside it,
// and nothing is styled unless stdout is a terminal (Windows 10 and later terminals read these codes).

const RESET = '\x1b[0m';
let enabled = !!process.stdout.isTTY;
/** `String.isColorizationEnabled`. */
export const setColours = (value: boolean) => { enabled = value; };

const style = (open: string) => (text: string) => enabled ? open + text.replaceAll(RESET, RESET + open) + RESET : text;
export const bold = style('\x1b[1m'), dim = style('\x1b[2m'), underline = style('\x1b[4m');
export const red = style('\x1b[31m'), green = style('\x1b[32m'), yellow = style('\x1b[33m'), magenta = style('\x1b[35m');
/** `foregroundColor(_:)`, a 256-colour palette entry: `TerminalColor.green` is 2 and `.red` 9. */
export const foreground = (colour: 'green' | 'red') => style(`\x1b[38;5;${colour === 'green' ? 2 : 9}m`);

export const CHECKMARK = () => green('✓');
export const EXCLAMATION = () => magenta('!');
export const CIRCLE = () => yellow('◌');
export const ERROR_X = () => red('✘');
export const ARROW = () => dim('->');
export const LINE_UP = '\x1b[1A';
export const LINE_CLEAR = '\x1b[2K';
