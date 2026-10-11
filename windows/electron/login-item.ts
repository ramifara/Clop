export interface LoginItems {
  getLoginItemSettings(options?: { path?: string; args?: string[] }): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean; path: string; args: string[] }): void;
}

/**
 * Makes the Windows login item match `launchAtLogin`. `clop settings set launchAtLogin` can change the setting while the app is
 * not running, so the app also checks it when it starts. Returns whether anything was changed.
 */
export function syncLoginItem(app: LoginItems, launchAtLogin: boolean, exe: string, onlyIfDifferent = false) {
  const args = ['--hidden'];
  if (onlyIfDifferent && app.getLoginItemSettings({ path: exe, args }).openAtLogin === launchAtLogin) return false;
  app.setLoginItemSettings({ openAtLogin: launchAtLogin, path: exe, args });
  return true;
}
