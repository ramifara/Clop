import type { ReactNode } from 'react';
import { controlFor } from '../../core/settings/controls';
import { PENDING_NOTE, type Control, type SettingEntry } from '../../core/settings/entries';
import { McpInstall, McpSwitch } from '../McpSettings';
import { rowDomId, useSettings, type SettingsEnv } from './context';
import { FormatSelect, NameTemplateField, NumberField, Switch, TextField } from './inputs';
import { ActionKeys, ActionsEditor, EditorApp, FolderList, IgnoredApps, ResizeKeys, TriggerKeys, Workdir } from './lists';
import { Compression, FpsCap, MinFps, PdfDpi, ResolutionRange, SizeRange } from './media';
import { FORMAT_OPTIONS } from './options';
import { About, Automation, PresetZones, SavedPipelines, Updates } from './panes';

/** Rows whose control sits beside the label; every other control gets the full width under it. */
const BESIDE: ReadonlySet<Control> = new Set(['toggle', 'mcpToggle', 'select', 'number', 'text', 'editorApp']);

/** The value a `select` offers for each option, as the setting stores it. */
function Select({ entry, env }: { entry: SettingEntry; env: SettingsEnv }) {
  const key = entry.keys[0], meta = env.metas.get(key)!, current = env.settings[key];
  const labels = new Map(entry.ui?.labels ?? []);
  const options = entry.ui?.labels ? entry.ui.labels.map(([value]) => value) : meta.values!.map(String);
  const shown = String(current);
  const all = options.includes(shown) ? options : [...options, shown];
  const parse = (text: string) => meta.values?.find(value => String(value) === text) ?? (meta.type === 'integer' || meta.type === 'number' ? Number(text) : text);
  return <select aria-label={entry.title} value={shown} onChange={event => env.change({ [key]: parse(event.target.value) })}>
    {all.map(option => <option key={option} value={option}>{labels.get(option) ?? (meta.type === 'enum' ? option.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, c => c.toUpperCase()) : option)}</option>)}
  </select>;
}

function body(entry: SettingEntry, control: Control, env: SettingsEnv): ReactNode {
  const { settings, change, metas } = env, key = entry.keys[0], meta = metas.get(key);
  const value = settings[key as keyof typeof settings] as never;
  switch (control) {
    case 'toggle': return <Switch label={entry.title} checked={value as boolean} onChange={checked => change({ [key]: checked })}/>;
    case 'mcpToggle': return <McpSwitch which={key === 'mcpEnabled' ? 'enable' : 'scripts'}/>;
    case 'select': return <Select entry={entry} env={env}/>;
    case 'number': return <NumberField label={entry.title} value={value as number} min={meta?.min ?? 0} max={meta?.max} unit={entry.ui?.unit} decimal={meta?.type === 'number'} onCommit={next => change({ [key]: next })}/>;
    case 'text': return <TextField label={entry.title} value={value as string} onCommit={next => change({ [key]: next })}/>;
    case 'list': return <TextField label={entry.title} value={(value as string[]).join(', ')} onCommit={next => change({ [key]: next.split(',').map(item => item.trim()).filter(Boolean) })}/>;
    case 'formats': return <FormatSelect label={entry.title} options={FORMAT_OPTIONS[key as keyof typeof FORMAT_OPTIONS] ?? []} value={value as string[]} onChange={next => change({ [key]: next })}/>;
    case 'nameTemplate': case 'pathTemplate': return <NameTemplateField settingKey={key} value={value as string} placeholder={String(meta?.default ?? '')} onCommit={next => change({ [key]: next })}/>;
    case 'compression': return <Compression settingKey={key as 'imageCompression'}/>;
    case 'pdfDpi': return <PdfDpi/>;
    case 'sizeRange': return <SizeRange keys={entry.keys}/>;
    case 'resolutionRange': return <ResolutionRange keys={entry.keys}/>;
    case 'fpsCap': return <FpsCap/>;
    case 'minFps': return <MinFps/>;
    case 'dirs': return <FolderList kind={entry.ui!.kind!}/>;
    case 'ignoredApps': return <IgnoredApps/>;
    case 'editorApp': return <EditorApp kind={entry.ui!.kind ?? (key.replace('editorApp', '').toLowerCase() as 'image')}/>;
    case 'workdir': return <Workdir/>;
    case 'modifiers': return <TriggerKeys/>;
    case 'actionKeys': return <ActionKeys/>;
    case 'resizeKeys': return <ResizeKeys/>;
    case 'actions': return <ActionsEditor settingKey={key as 'floatingResultActions'}/>;
    case 'presetZones': return <PresetZones/>;
    case 'pipelines': return <SavedPipelines/>;
    case 'automation': return <Automation kind={entry.ui!.kind}/>;
    case 'sourceAutomation': return <Automation source={entry.ui!.source}/>;
    case 'mcpInstall': return <McpInstall/>;
    case 'updates': return <Updates/>;
    case 'about': return <About/>;
    default: return null;
  }
}

/** One row of a tab: the label and subtitle from the index, the control the schema or the row's `ui` calls for. Dimmed and disabled while its condition does not hold. */
export function EntryRow({ entry, flash, note = true }: { entry: SettingEntry; flash: boolean; note?: boolean }) {
  const env = useSettings();
  const control = controlFor(entry, env.metas);
  if (!control || control === 'embedded') return null;
  const enabled = !entry.ui?.when || entry.ui.when.some(([key, expected]) => env.settings[key] === expected);
  const beside = BESIDE.has(control);
  // A row that is all of its section says its name once, in the section heading.
  const pending = note && entry.ui?.pending ? <small className="pending" title={entry.ui.pending}>{PENDING_NOTE}</small> : null;
  // About and Updates draw their own heading.
  const headless = control === 'about' || control === 'updates';
  const showTitle = entry.title.toLowerCase() !== entry.section.toLowerCase();
  return <div className={`s-row ${beside ? '' : 'stacked'} ${enabled ? '' : 'inactive'} ${flash ? 'flash' : ''}`} id={rowDomId(entry.id)} data-row={entry.id}>
    {(showTitle || entry.subtitle || pending) && !headless && <div className="s-label">{showTitle && <strong>{entry.title}</strong>}{entry.subtitle && <small>{entry.subtitle}</small>}{pending}</div>}
    <fieldset className="s-control" disabled={!enabled}>{body(entry, control, env)}</fieldset>
  </div>;
}
