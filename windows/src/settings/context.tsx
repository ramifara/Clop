import { createContext, useContext } from 'react';
import type { SettingMeta } from '../../core/settings/controls';
import type { ClopSettings, PrefsReply, PrefsRequest } from '../types';

/** What every control in the Settings window reads and calls: the settings, their schema, and the ways to change them. */
export interface SettingsEnv {
  settings: ClopSettings;
  metas: ReadonlyMap<string, SettingMeta>;
  native: boolean;
  platform: string;
  /** Runs an action of the main process: errors are shown in the window, and the settings are read again afterwards. */
  run(task: () => Promise<unknown>, success?: string): Promise<boolean>;
  /** Saves values through the `settings` action; the main process checks them. */
  change(partial: Partial<ClopSettings>): void;
  /** A settings action of the main process: a picker or a list edit. Resolves to undefined when it failed (the window shows why). */
  prefs(request: PrefsRequest): Promise<PrefsReply | undefined>;
  /** A question for the main process that changes nothing (a preview, the version); a failure gives undefined and no message. */
  ask(request: PrefsRequest): Promise<PrefsReply | undefined>;
}
export const SettingsContext = createContext<SettingsEnv | undefined>(undefined);
export function useSettings(): SettingsEnv {
  const env = useContext(SettingsContext);
  if (!env) throw new Error('Settings controls need the Settings window.');
  return env;
}
/** The `id` a row is given in the page, which links and search results scroll to. */
export const rowDomId = (id: string) => `row-${id}`;
export const clean = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);
