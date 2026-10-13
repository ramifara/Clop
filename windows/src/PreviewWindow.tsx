import { useEffect, useRef, useState } from 'react';
import { api, errorText } from './api';
import { humanSize } from './results';
import type { CompareSources, ItemResult } from './types';
import './views.css';

/** What decides whether the result the window shows is still the item's current one. */
const outputKey = (item: ItemResult) => JSON.stringify([item.format, item.outputBytes, item.width, item.height, item.pages, item.restored, item.options]);

/**
 * The preview window (QuickLook's place on Windows): the current result at full size. Images and PDF pages are pictures, videos and
 * audio files play with their own controls, and Space or Esc closes it.
 */
export function PreviewWindow({ id }: { id: string }) {
  const [sources, setSources] = useState<CompareSources>();
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [reloads, setReloads] = useState(0);
  const shown = useRef<string>(undefined);
  useEffect(() => {
    let current = true;
    api.compareSources(id, { page }).then(next => { if (current) { setSources(next); setError(''); shown.current = outputKey(next.item); } }, error => { if (current) setError(errorText(error)); });
    return () => { current = false; };
  }, [id, page, reloads]);
  // The result changes under an open window (a downscale, a restore, a crop): show the new one.
  useEffect(() => api.subscribe(state => {
    const item = state.items.find(candidate => candidate.id === id);
    if (item?.status === 'ready' && shown.current !== undefined && outputKey(item) !== shown.current) setReloads(count => count + 1);
  }), [id]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && ['INPUT', 'VIDEO', 'AUDIO'].includes(event.target.tagName) && event.key === ' ') return;
      if (event.key === 'Escape' || event.key === ' ') { event.preventDefault(); void api.window('close'); }
      else if (sources?.pages && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) setPage(value => Math.min(Math.max(value + (event.key === 'ArrowLeft' ? -1 : 1), 1), sources.pages!));
    };
    document.addEventListener('keydown', keys); return () => document.removeEventListener('keydown', keys);
  }, [sources?.pages]);
  if (!sources) return <div className="view-window preview-window"><div className="view-loading">{error || <span className="spinner"/>}</div></div>;
  const { result, item } = sources, size = result.width && result.height ? `${result.width}×${result.height}` : '';
  return <div className="view-window preview-window">
    <div className="preview-stage">
      {result.kind === 'video' ? <video src={result.url} controls autoPlay loop playsInline/>
        : result.kind === 'audio' ? <div className="preview-audio"><div className="audio-art" style={{ backgroundImage: `url("${item.originalPreview}")` }}/><audio src={result.url} controls autoPlay/></div>
        : <img src={result.url} alt={item.name} draggable={false}/>}
    </div>
    <footer className="preview-bar">
      <strong title={item.name}>{item.name}</strong><span>{result.format.toUpperCase()}</span><span>{humanSize(result.bytes)}</span>{size && <span>{size}</span>}
      {sources.pages && <span className="preview-pages">{sources.pages > 1 && <button className="flat" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>}Page {sources.page}/{sources.pages}{sources.pages > 1 && <button className="flat" aria-label="Next page" disabled={page >= sources.pages} onClick={() => setPage(page + 1)}>›</button>}</span>}
    </footer>
    {error && <p className="view-error" role="alert">{error}</p>}
  </div>;
}
