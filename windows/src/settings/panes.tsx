import { useEffect, useState } from 'react';
import type { MediaName } from '../../core/settings/entries';
import { PIPELINE_SOURCE_KEYS_FOR_UI, pipelineLabel, type PipelineLike } from './pipelines';
import { useSettings } from './context';

// The panes that show what the pipeline editor owns (saved pipelines, what runs on a source, preset zones) and the Updates and About
// panes. The pipelines themselves are written in the editor or with the `clop pipeline` commands, never as raw values from here.

const KIND_TITLES: Record<MediaName, string> = { image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF' };
const KINDS = ['image', 'video', 'audio', 'pdf'] as const;

/** Opens the pipeline editor window, on its preset zones when `zones`. */
function EditButton({ label = 'Open the pipeline editor', zones = false }: { label?: string; zones?: boolean }) {
  const { prefs } = useSettings();
  return <button className="button" onClick={() => void prefs({ action: 'pipeline-editor', ...(zones ? { tab: 'zones' as const } : {}) })}>{label}</button>;
}

/** The saved pipeline library, by the file type each pipeline is for. */
export function SavedPipelines() {
  const { settings } = useSettings();
  const pipelines = settings.savedPipelines as unknown as PipelineLike[];
  const sections: [string, MediaName | undefined][] = [...KINDS.map(kind => [KIND_TITLES[kind], kind] as [string, MediaName]), ['Any type', undefined]];
  return <div className="pipelines"><div className="buttons"><EditButton/></div>{sections.map(([title, type]) => {
    const own = pipelines.filter(pipeline => ('reason' in pipeline ? undefined : pipeline.fileType) === type && (type !== undefined || !('reason' in pipeline)));
    return <section key={title} aria-label={`${title} pipelines`}>
      <header><strong>{title}</strong></header>
      {own.length ? <ul>{own.map((pipeline, index) => <li key={'id' in pipeline ? pipeline.id : index}><span className="name">{pipelineLabel(pipeline)}</span><code title={'rawText' in pipeline ? pipeline.rawText : undefined}>{'rawText' in pipeline ? pipeline.rawText : ''}</code></li>)}</ul> : <small>No pipelines yet</small>}
    </section>;
  })}
  {pipelines.some(pipeline => 'reason' in pipeline) && <small>{pipelines.filter(pipeline => 'reason' in pipeline).length} saved pipeline(s) could not be read by this version; they are kept as they are.</small>}</div>;
}

/** What runs on a source after optimisation: the pipelines of one file type (the Automation tab), or of one source across file types (Clipboard, Drop zone). */
export function Automation({ kind, source }: { kind?: MediaName; source?: 'clipboard' | 'dropZone' }) {
  const { settings } = useSettings();
  const saved = settings.savedPipelines as unknown as PipelineLike[];
  const kinds = kind ? [kind] : [...KINDS];
  const groups = kinds.flatMap(type => {
    const attached = settings[PIPELINE_SOURCE_KEYS_FOR_UI[type]] as unknown as Record<string, PipelineLike[]>;
    return Object.entries(attached ?? {}).filter(([key]) => !source || key === source).map(([key, list]) => ({ type, source: key, names: list.map(pipeline => pipelineLabel(pipeline, saved)) }));
  }).filter(group => group.names.length);
  const sourceName = (key: string) => key === 'clipboard' ? 'Clipboard' : key === 'dropZone' ? 'Drop zone' : key;
  return <div className="list">
    {groups.length ? <ul className="automation">{groups.map(group => <li key={`${group.type}:${group.source}`}>
      <span className="s-source" title={group.source}>{kind ? sourceName(group.source) : `${KIND_TITLES[group.type]}${source ? '' : ` · ${sourceName(group.source)}`}`}</span>
      <span className="steps">{group.names.join(' → ')}</span>
    </li>)}</ul> : <small>{source ? 'Nothing runs automatically.' : 'No pipelines are attached to the clipboard or to a watched folder.'}</small>}
    <EditButton label="Edit in the pipeline editor"/>
  </div>;
}

/** The preset zones that appear over the drop zone, each running a pipeline. */
export function PresetZones() {
  const { settings } = useSettings();
  const zones = settings.presetZones as unknown as { id?: string; name?: string; type?: MediaName; pipeline?: PipelineLike; reason?: string }[];
  return <div className="list">
    {zones.length ? <ul className="s-zones">{zones.map((zone, index) => <li key={zone.id ?? index}>
      <strong>{zone.reason ? 'Unreadable zone' : zone.name || 'Zone'}</strong>
      {!zone.reason && <small>{[zone.type ? KIND_TITLES[zone.type] : 'Any type', zone.pipeline ? pipelineLabel(zone.pipeline, settings.savedPipelines as unknown as PipelineLike[]) : ''].filter(Boolean).join(' · ')}</small>}
    </li>)}</ul> : <small>No preset zones yet. Click a zone to assign or create a pipeline, or add one with the clop command.</small>}
    <EditButton label="Edit in the pipeline editor" zones/>
  </div>;
}

function Links({ children }: { children: React.ReactNode }) { return <div className="buttons">{children}</div>; }

function useVersion() {
  const { ask } = useSettings();
  const [version, setVersion] = useState<{ name: string; platform: string }>();
  useEffect(() => { void ask({ action: 'version' }).then(reply => setVersion(reply?.version)); }, [ask]);
  return version;
}

export function Updates() {
  const { prefs } = useSettings();
  const version = useVersion();
  return <div className="list">
    <p className="about-line"><strong>Clop for Windows {version?.name ?? ''}</strong></p>
    <small>Clop for Windows is free software under the GPLv3, so there is no licence to enter. New versions are published as releases on GitHub; download the installer or portable build there. The app does not check for updates by itself.</small>
    <Links><button className="button" onClick={() => void prefs({ action: 'open', target: 'releases' })}>Open the releases page</button></Links>
  </div>;
}

export function About() {
  const { prefs } = useSettings();
  const version = useVersion();
  return <div className="list about">
    <h3>Clop</h3>
    <p className="about-line">Version {version?.name ?? '…'}{version ? ` · ${version.platform}` : ''}</p>
    <small>Optimises images, videos, PDFs and audio from the clipboard, a drop zone and watched folders. This is a Windows port of Clop by the Lowtech Guys, under the same GPLv3 licence.</small>
    <Links>
      <button className="button" onClick={() => void prefs({ action: 'open', target: 'source' })}>Source code</button>
      <button className="button" onClick={() => void prefs({ action: 'open', target: 'upstream' })}>Clop for Mac</button>
      <button className="button" onClick={() => void prefs({ action: 'open', target: 'issues' })}>Report a problem</button>
    </Links>
  </div>;
}
