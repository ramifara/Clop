import type { SettingKey } from './schema';
import type { Control, SettingEntry } from './entries';

/** What the window knows of a setting without the schema module (which needs Node): enough to draw and bound its control. */
export interface SettingMeta {
  key: SettingKey;
  type: 'boolean' | 'integer' | 'number' | 'string' | 'enum' | 'list' | 'object';
  default: unknown;
  description: string;
  values?: readonly (string | number)[];
  min?: number;
  max?: number;
  windowsOnly: boolean;
  unsupportedOnWindows: boolean;
  encoding?: string;
}

const BY_TYPE: Record<SettingMeta['type'], Control | undefined> = { boolean: 'toggle', enum: 'select', integer: 'number', number: 'number', string: 'text', list: 'list', object: undefined };

/** The control a row is drawn with: the one its `ui` names, else the one its first setting's type calls for. Undefined when a row needs a `ui.control`. */
export function controlFor(entry: SettingEntry, metas: ReadonlyMap<string, SettingMeta>): Control | undefined {
  if (entry.ui?.control) return entry.ui.control;
  const meta = entry.keys.length === 1 ? metas.get(entry.keys[0]) : undefined;
  return meta && BY_TYPE[meta.type];
}
