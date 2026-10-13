import type { ZoneView } from '../../core/pipeline/editor-state';

/** Leaving the pipeline library with typed-in changes: true when it is fine to go, asking the user first when there are changes. */
export function mayLeave(dirty: boolean, ask: (question: string) => boolean) {
  return !dirty || ask('Discard the unsaved changes to this pipeline?');
}

/** A zone row keeps its place (and what is typed in it) when the zone is saved elsewhere; only the entry itself changes its key. */
export const zoneRowKey = (zone: ZoneView) => zone.key;

/**
 * The JSON typed for an unreadable entry that was then changed elsewhere. An unreadable entry without an id is named by a hash of
 * what it holds, so a change elsewhere leaves nothing to fix; what was typed stays in view, ready to copy.
 */
export function LostJson({ json, copy, discard }: { json: string; copy: () => void; discard: () => void }) {
  return <div className="conflict" role="alert">
    <p>This pipeline was changed or removed elsewhere, and the JSON you typed for it is no longer attached to anything. Copy it if you want to keep it.</p>
    <textarea readOnly aria-label="The JSON you typed" value={json} rows={10} spellCheck={false}/>
    <p><button type="button" onClick={copy}>Copy</button> <button type="button" onClick={discard}>Discard</button></p>
  </div>;
}
