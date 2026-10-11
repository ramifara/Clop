import { useState } from 'react';
import { FILE_TYPES, type ClopFileType } from '../../core/pipeline/model';
import type { EditorState, PipelineView, ZoneView } from '../../core/pipeline/editor-state';
import { TYPE_NAMES } from './Library';
import { ICON_NAMES, glyph } from './glyphs';
import type { Send } from './types';

const serves = (pipeline: PipelineView, type: ClopFileType | undefined) => !pipeline.fileType || pipeline.fileType === type;

/**
 * The preset zones: tiles that show next to the drop target while Ctrl or Alt is held during a drag, each running one library
 * pipeline on what is dropped on it (`PresetZones.swift`). Up to four show at a time for the type being dragged.
 */
export function Zones({ state, send }: { state: EditorState; send: Send }) {
  const library = state.library.flatMap(entry => entry.readable ? [entry] : []);
  const [adding, setAdding] = useState({ name: '', icon: 'wand.and.sparkles', type: '' as ClopFileType | '', pipelineId: '' });
  const type = adding.type || undefined, options = library.filter(entry => serves(entry, type));
  const pipelineId = options.some(entry => entry.key === adding.pipelineId) ? adding.pipelineId : options[0]?.key ?? '';
  return <div className="zones">
    <p className="explain">Drag a file and hold <kbd>Ctrl</kbd> or <kbd>Alt</kbd>: tiles for these zones show next to the drop target. Drop the file on a tile to optimise it and run that tile's pipeline. Up to four tiles show, those for the dragged file type first.</p>
    <ul className="zone-list" aria-label="Preset zones">
      {state.zones.map((zone, index) => <ZoneRow key={zone.key} zone={zone} index={index} count={state.zones.length} library={library} send={send}/>)}
      {!state.zones.length && <li className="empty">No preset zones yet.</li>}
    </ul>
    <form className="zone-add" onSubmit={event => { event.preventDefault(); void send({ type: 'zone-save', name: adding.name, icon: adding.icon, fileType: type, pipelineId }).then(reply => { if (reply && !reply.issues) setAdding({ ...adding, name: '' }); }); }}>
      <h2>Add a zone</h2>
      <div className="zone-fields">
        <select aria-label="New zone icon" value={adding.icon} onChange={event => setAdding({ ...adding, icon: event.target.value })}>{ICON_NAMES.map(name => <option key={name} value={name}>{glyph(name)} {name}</option>)}</select>
        <input aria-label="New zone name" placeholder="Name" maxLength={40} value={adding.name} onChange={event => setAdding({ ...adding, name: event.target.value })}/>
        <select aria-label="New zone file type" value={adding.type} onChange={event => setAdding({ ...adding, type: event.target.value as ClopFileType | '' })}><option value="">Any file type</option>{FILE_TYPES.map(kind => <option key={kind} value={kind}>{TYPE_NAMES[kind]} files</option>)}</select>
        <select aria-label="New zone pipeline" value={pipelineId} onChange={event => setAdding({ ...adding, pipelineId: event.target.value })}>{options.map(entry => <option key={entry.key} value={entry.key}>{entry.name}</option>)}{!options.length && <option value="">No pipeline for these files</option>}</select>
        <button type="submit" className="primary" disabled={!adding.name.trim() || !pipelineId}>Add</button>
      </div>
    </form>
  </div>;
}

function ZoneRow({ zone, index, count, library, send }: { zone: ZoneView; index: number; count: number; library: PipelineView[]; send: Send }) {
  const [name, setName] = useState(zone.name);
  if (!zone.readable) return <li className="zone bad"><span className="glyph" aria-hidden="true">⚠</span><span className="zone-name">{zone.name}</span><small>{zone.reason}</small>
    <button type="button" className="danger" onClick={() => void send({ type: 'zone-delete', key: zone.key })}>Remove</button></li>;
  const save = (patch: { name?: string; icon?: string; fileType?: ClopFileType | null; pipelineId?: string }) => {
    const fileType = patch.fileType === undefined ? zone.type : patch.fileType ?? undefined;
    void send({ type: 'zone-save', id: zone.key, name: patch.name ?? zone.name, icon: patch.icon ?? zone.icon, fileType, pipelineId: patch.pipelineId });
  };
  const options = library.filter(entry => serves(entry, zone.type));
  return <li className={zone.missing ? 'zone bad' : 'zone'}>
    <span className="move"><button type="button" aria-label={`Move ${zone.name} up`} disabled={index === 0} onClick={() => void send({ type: 'zone-move', key: zone.key, to: index - 1 })}>▲</button>
      <button type="button" aria-label={`Move ${zone.name} down`} disabled={index === count - 1} onClick={() => void send({ type: 'zone-move', key: zone.key, to: index + 1 })}>▼</button></span>
    <label className="icon-pick" title="Icon"><span className="glyph big" aria-hidden="true">{glyph(zone.icon)}</span>
      <select aria-label={`Icon of ${zone.name}`} value={ICON_NAMES.includes(zone.icon) ? zone.icon : ''} onChange={event => event.target.value && save({ icon: event.target.value })}>
        {!ICON_NAMES.includes(zone.icon) && <option value="">{zone.icon}</option>}{ICON_NAMES.map(icon => <option key={icon} value={icon}>{glyph(icon)} {icon}</option>)}</select></label>
    <input className="zone-name" aria-label={`Name of ${zone.name}`} maxLength={40} value={name} onChange={event => setName(event.target.value)} onBlur={() => { if (name.trim() && name !== zone.name) save({ name }); else setName(zone.name); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/>
    <select aria-label={`File type of ${zone.name}`} value={zone.type ?? ''} onChange={event => save({ fileType: (event.target.value || null) as ClopFileType | null })}><option value="">Any file type</option>{FILE_TYPES.map(kind => <option key={kind} value={kind}>{TYPE_NAMES[kind]} files</option>)}</select>
    <select aria-label={`Pipeline of ${zone.name}`} title={zone.text} value={zone.libraryID && options.some(entry => entry.key === zone.libraryID) ? zone.libraryID : ''} onChange={event => event.target.value && save({ pipelineId: event.target.value })}>
      {!(zone.libraryID && options.some(entry => entry.key === zone.libraryID)) && <option value="">{zone.missing ? 'Pipeline deleted: choose one' : zone.libraryID ? `${zone.pipelineName} (does not fit)` : zone.pipelineName}</option>}
      {options.map(entry => <option key={entry.key} value={entry.key}>{entry.name}</option>)}</select>
    <button type="button" className="danger" aria-label={`Remove ${zone.name}`} onClick={() => void send({ type: 'zone-delete', key: zone.key })}>Remove</button>
  </li>;
}
