import { useEffect, useState } from 'react';
import type { MediaName } from '../../core/settings/entries';
import { api } from '../api';
import { Icon } from '../icons';
import type { AppEntry, ClopSettings } from '../types';
import { KEY_MODIFIERS, describeAccelerator, formatAccelerator, modifierLabel, triggerProblem, type Modifier } from './accelerator';
import { useSettings } from './context';
import { AcceleratorRecorder, Chip, Switch } from './inputs';
import { ACTION_KEYS, ACTION_LABELS, OFFERED_ACTIONS, RESIZE_KEYS } from './options';

const DIRS = { image: 'imageDirs', video: 'videoDirs', audio: 'audioDirs', pdf: 'pdfDirs' } as const;
const EDITORS = { image: 'editorAppImage', video: 'editorAppVideo', audio: 'editorAppAudio', pdf: 'editorAppPDF' } as const;
const NOUNS = { image: 'images', video: 'videos', audio: 'audio files', pdf: 'PDFs' } as const;
const comparable = (value: string) => value.toLowerCase().replaceAll('\\', '/').replace(/(?<=.)\/+$/, '');
const baseName = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? value;

/** The watched folders of one file type, each with whether its results show as floating cards. Adding opens the folder picker in the main process. */
export function FolderList({ kind }: { kind: MediaName }) {
  const { settings, prefs } = useSettings();
  const folders = settings[DIRS[kind]], quiet = settings.dirsHideFloatingResult.map(comparable);
  return <div className="list">
    {folders.length ? <ul>{folders.map(folder => <li key={folder}>
      <span className="path" title={folder}>{folder}</span>
      <label className="inline"><Switch label={`Show floating results for ${folder}`} checked={!quiet.includes(comparable(folder))} onChange={show => void prefs({ action: 'quiet', folder, quiet: !show })}/>Show floating results</label>
      <button className="icon" aria-label={`Stop watching ${folder}`} onClick={() => void prefs({ action: 'folder', kind, op: 'remove', folder })}><Icon name="close" size={9}/></button>
    </li>)}</ul> : <small>No folders are watched for {NOUNS[kind]}.</small>}
    <button className="button" onClick={() => void prefs({ action: 'folder', kind, op: 'add' })}>Add folder…</button>
  </div>;
}

/** Programs whose clipboard copies are left alone: running and Start Menu apps from the Windows helper, or any program picked from disk. */
export function IgnoredApps() {
  const { settings, prefs } = useSettings();
  const ignored = settings.clipboardIgnoredAppBundleIds;
  const [apps, setApps] = useState<AppEntry[]>();
  // The list is read again whenever the window shows, since programs start and stop meanwhile.
  useEffect(() => {
    const load = () => { if (document.visibilityState === 'visible') api.apps().then(setApps, () => setApps([])); };
    load(); document.addEventListener('visibilitychange', load);
    return () => document.removeEventListener('visibilitychange', load);
  }, []);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const name = (entry: string) => apps?.find(app => same(app.path, entry))?.name ?? baseName(entry);
  return <div className="list">
    {ignored.length ? <ul>{ignored.map(entry => <li key={entry} title={entry}><span className="path">{name(entry)}</span>
      <button className="icon" aria-label={`Stop ignoring ${name(entry)}`} onClick={() => void prefs({ action: 'ignore', op: 'remove', entry })}><Icon name="close" size={9}/></button></li>)}</ul> : <small>None: copies from every app are optimised.</small>}
    <div className="buttons">
      <select aria-label="Ignore an app" value="" onChange={event => { if (event.target.value) void prefs({ action: 'ignore', op: 'add', entry: event.target.value }); }}>
        <option value="">{apps ? 'Add an app…' : 'Loading apps…'}</option>
        {apps?.filter(app => !ignored.some(entry => same(entry, app.path))).map(app => <option key={app.path} value={app.path} title={app.path}>{app.running ? `${app.name} (running)` : app.name}</option>)}
      </select>
      <button className="button" onClick={() => void prefs({ action: 'ignore', op: 'choose' })}>Choose program…</button>
    </div>
  </div>;
}

/** The program "Edit with" opens for one file type; empty means the Windows default app. */
export function EditorApp({ kind }: { kind: MediaName }) {
  const { settings, prefs } = useSettings();
  const app = settings[EDITORS[kind]];
  return <div className="path-control">
    <span className="path" title={app || undefined}>{app ? baseName(app) : 'Default app'}</span>
    <button className="button" onClick={() => void prefs({ action: 'editor', kind, op: 'choose' })}>Choose…</button>
    {app && <button className="button" onClick={() => void prefs({ action: 'editor', kind, op: 'clear' })}>Use default</button>}
  </div>;
}

export function Workdir() {
  const { settings, prefs } = useSettings();
  return <div className="path-control">
    <span className="path mono" title={settings.workdir}>{settings.workdir}</span>
    <button className="button" onClick={() => void prefs({ action: 'workdir', op: 'choose' })}>Choose…</button>
    <button className="button" onClick={() => void prefs({ action: 'workdir', op: 'reset' })}>Reset</button>
  </div>;
}

/** The buttons of a floating or compact result, in order: take one off, move it, add one back. */
export function ActionsEditor({ settingKey }: { settingKey: 'floatingResultActions' | 'compactResultActions' }) {
  const { settings, change } = useSettings();
  const actions = settings[settingKey];
  const label = (action: string) => ACTION_LABELS[action] ?? (action.startsWith('pipeline:') ? 'Pipeline' : action);
  const move = (index: number, by: number) => { const next = [...actions]; [next[index], next[index + by]] = [next[index + by], next[index]]; change({ [settingKey]: next }); };
  const unused = OFFERED_ACTIONS.filter(action => !actions.includes(action));
  return <div className="list">
    <ol className="actions">{actions.map((action, index) => <li key={action}>
      <span>{label(action)}</span>
      <button className="icon" aria-label={`Move ${label(action)} up`} disabled={index === 0} onClick={() => move(index, -1)}><Icon name="up" size={11}/></button>
      <button className="icon" aria-label={`Move ${label(action)} down`} disabled={index === actions.length - 1} onClick={() => move(index, 1)}><Icon name="chevron" size={11}/></button>
      <button className="icon" aria-label={`Remove ${label(action)}`} onClick={() => change({ [settingKey]: actions.filter(other => other !== action) })}><Icon name="close" size={9}/></button>
    </li>)}</ol>
    {unused.length > 0 && <select aria-label="Add a button" value="" onChange={event => { if (event.target.value) change({ [settingKey]: [...actions, event.target.value] }); }}>
      <option value="">Add a button…</option>{unused.map(action => <option key={action} value={action}>{ACTION_LABELS[action]}</option>)}
    </select>}
  </div>;
}

/** The modifiers held with an action key, which the shortcut previews and the recorder share. */
const useModifiers = () => useSettings().settings.keyComboModifiers as Modifier[];

/** The modifiers held with an action key. Tick them, or press the combination you want. */
export function TriggerKeys() {
  const { change } = useSettings(), modifiers = useModifiers();
  const [problem, setProblem] = useState<string>();
  const save = (next: Modifier[]) => {
    const ordered = KEY_MODIFIERS.filter(modifier => next.includes(modifier)), why = triggerProblem(ordered);
    setProblem(why);
    if (!why) change({ keyComboModifiers: ordered });
  };
  return <div className="list">
    <div className="s-chips">{KEY_MODIFIERS.map(modifier => <Chip key={modifier} on={modifiers.includes(modifier)} onClick={() => save(modifiers.includes(modifier) ? modifiers.filter(other => other !== modifier) : [...modifiers, modifier])}>{modifierLabel(modifier)}</Chip>)}</div>
    <div className="buttons"><AcceleratorRecorder mode="modifiers" label="Record trigger keys" value={modifiers.join('+')} onRecord={({ modifiers: held }) => save(held)}/><small>Or click and press the keys together.</small></div>
    {problem && <small className="problem" role="alert">{problem}</small>}
  </div>;
}

/** Each action key with the shortcut it makes (the trigger keys plus the key), and a switch. Keys the setting holds that this list does not know stay. */
export function ActionKeys() {
  const { settings, change } = useSettings(), modifiers = useModifiers(), enabled = settings.enabledKeys;
  return <div className="key-list">{ACTION_KEYS.map(action => {
    const on = enabled.includes(action.key), shortcut = describeAccelerator(formatAccelerator(modifiers, action.key));
    return <label className="key-row" key={action.key}>
      <kbd>{shortcut}</kbd>
      <span><strong>{action.name}</strong><small>{action.description}</small></span>
      <Switch label={`${action.name} (${shortcut})`} checked={on} onChange={checked => change({ enabledKeys: checked ? [...enabled, action.key] : enabled.filter(key => key !== action.key) })}/>
    </label>;
  })}</div>;
}

/** Hold the trigger keys and press a number to downscale the latest result to that many tenths. */
export function ResizeKeys() {
  const { settings, change } = useSettings(), modifiers = useModifiers(), keys = settings.quickResizeKeys as ClopSettings['quickResizeKeys'];
  return <div className="list">
    <small>Hold {describeAccelerator(modifiers.join('+')) || 'the trigger keys'} and press a number to downscale to that percentage.</small>
    <div className="s-chips">{RESIZE_KEYS.map(key => <Chip key={key} on={keys.includes(key)} title={`${describeAccelerator(formatAccelerator(modifiers, key))} downscales to ${Number(key) * 10}%`} onClick={() => change({ quickResizeKeys: keys.includes(key) ? keys.filter(other => other !== key) : [...keys, key] })}>{key}<small>{Number(key) * 10}%</small></Chip>)}</div>
  </div>;
}
