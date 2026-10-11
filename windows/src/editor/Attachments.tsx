import { FILE_TYPES } from '../../core/pipeline/model';
import type { EditorState } from '../../core/pipeline/editor-state';
import { TYPE_NAMES } from './Library';
import { glyph } from './glyphs';
import type { Send } from './types';

const EXPLAIN: Record<string, string> = {
  Clipboard: 'Runs on files and images you copy, after Clop optimises them.',
  'Drop zone': 'Runs on files dropped on the drop target.',
};

/** Which pipelines run on what Clop picks up: from the clipboard, from the drop zone and from each watched folder, per file type. */
export function Attachments({ state, send }: { state: EditorState; send: Send }) {
  const library = state.library.flatMap(entry => entry.readable ? [entry] : []);
  return <div className="attachments">
    <p className="explain">Pipelines attached to a place run on every file of that type that arrives there. Watched folders are set in Clop's settings.</p>
    {FILE_TYPES.map(kind => <section key={kind} aria-label={`${TYPE_NAMES[kind]} files`}>
      <h2>{TYPE_NAMES[kind]} files</h2>
      {state.attachments[kind].map(source => {
        const attachable = library.filter(entry => (!entry.fileType || entry.fileType === kind) && !source.entries.some(attached => attached.libraryID === entry.key));
        return <div key={source.source} className="source">
          <div className="source-head"><strong title={source.source}>{source.label}</strong>{!source.configured && <span className="badge warn">no longer watched</span>}<small>{EXPLAIN[source.label] ?? ''}</small></div>
          <ul className="attached">
            {source.entries.map(entry => <li key={entry.key} className={entry.missing || !entry.readable ? 'bad' : undefined} title={entry.text}>
              <span className="glyph" aria-hidden="true">{glyph(library.find(candidate => candidate.key === entry.libraryID)?.icon)}</span>{entry.name}
              <button type="button" aria-label={`Detach ${entry.name} from ${source.label}`} onClick={() => void send({ type: 'detach', fileType: kind, source: source.source, key: entry.key })}>×</button></li>)}
            {!source.entries.length && <li className="none">Nothing attached</li>}
          </ul>
          <select aria-label={`Attach a pipeline to ${source.label} for ${kind} files`} value="" disabled={!source.configured && !attachable.length} onChange={event => { if (event.target.value) void send({ type: 'attach', fileType: kind, source: source.source, pipelineId: event.target.value }); }}>
            <option value="">{attachable.length ? 'Attach…' : 'No pipeline to attach'}</option>{attachable.map(entry => <option key={entry.key} value={entry.key}>{entry.name || 'Unnamed pipeline'}</option>)}</select>
        </div>;
      })}
    </section>)}
  </div>;
}
