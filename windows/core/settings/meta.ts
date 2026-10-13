import { defaultSettings, settingsSchema, SETTING_KEYS } from './schema';
import type { SettingMeta } from './controls';
import type { DefaultPaths } from './paths';

/** The schema as the Settings window reads it: types, bounds, allowed values and resolved defaults for every setting. */
export function settingsMeta(paths: Partial<DefaultPaths> = {}): SettingMeta[] {
  const defaults = defaultSettings(paths);
  return SETTING_KEYS.map(key => {
    const spec: { type: SettingMeta['type']; description: string; values?: readonly (string | number)[]; min?: number; max?: number; windowsOnly?: true; unsupportedOnWindows?: true; encoding?: string } = settingsSchema[key];
    return { key, type: spec.type, default: defaults[key], description: spec.description, values: spec.values, min: spec.min, max: spec.max, windowsOnly: !!spec.windowsOnly, unsupportedOnWindows: !!spec.unsupportedOnWindows, encoding: spec.encoding };
  });
}
