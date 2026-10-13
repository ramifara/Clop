export interface LoginItems {
  getLoginItemSettings(options?: { path?: string; args?: string[] }): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean; path: string; args: string[] }): void;
}

/**
 * The program the login item starts: the portable app's own launcher when there is one (it unpacks to a new temporary folder on
 * every run, so `process.execPath` is gone once the app exits), else the installed program.
 */
export const loginExecutable = (env: NodeJS.ProcessEnv = process.env, execPath = process.execPath) => env.PORTABLE_EXECUTABLE_FILE || execPath;

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
