import type { EditorCommand, EditorReply } from '../types';

/** Sends a command to the main process. Resolves with its reply, or undefined when it failed (the failure is on screen). */
export type Send = (command: EditorCommand) => Promise<EditorReply | undefined>;
