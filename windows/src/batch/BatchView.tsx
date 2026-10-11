import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import type { BatchItem } from '../../core/batch/engine';
import type { MediaKind } from '../../core/media/types';
import { Icon } from '../icons';
import { batchApi as api } from './api';
import { ParamCards } from './ParamCards';
import type { BatchFailure, BatchFile, BatchParams, BatchSnapshot, BatchViewState } from './types';
import './batch.css';

// BatchPrepView.swift: the batch window's prepare panel (files and parameter cards), results table and failures sheet.

const KIND_ORDER: Record<MediaKind, number> = { image: 0, video: 1, pdf: 2, audio: 3 };
const STATUS_ORDER = { running: 0, queued: 1, done: 2, reverted: 2, failed: 3, skipped: 4 } as const;
export function humanBytes(n: number) { return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`; }
const savedPercent = (old: number, now?: number) => old > 0 && now ? Math.round((old - now) / old * 100) : undefined;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
type Run = <T>(task: () => Promise<T>) => Promise<T | undefined>;

/** Sorts rows by a column; clicking the column again reverses it. */
function useSort<T>(rows: T[], columns: Record<string, (row: T) => number | string>, initial: string) {
  const [sort, setSort] = useState({ key: initial, ascending: true });
  const sorted = useMemo(() => {
    const value = columns[sort.key];
    return [...rows].sort((a, b) => { const x = value(a), y = value(b), order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }); return sort.ascending ? order : -order; });
  }, [rows, sort, columns]);
  const header = (key: string, title: ReactNode, className = '') => <th className={className} aria-sort={sort.key === key ? sort.ascending ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => setSort({ key, ascending: sort.key === key ? !sort.ascending : true })}>{title}{sort.key === key && <span className="sort">{sort.ascending ? '▲' : '▼'}</span>}</button></th>;
  return { sorted, header };
}

/** Click selects a row, Ctrl adds it to the selection and Shift selects a range. */
function useSelection(order: string[]) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string>();
  const click = (id: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (event.shiftKey && anchor) { const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y); setSelected(new Set(order.slice(a, b + 1))); return; }
    setAnchor(id);
    if (event.ctrlKey || event.metaKey) { const next = new Set(selected); if (!next.delete(id)) next.add(id); setSelected(next); }
    else setSelected(new Set([id]));
  };
  return { selected, click, clear: () => setSelected(new Set()) };
}

export function BatchView() {
  const [state, setState] = useState<BatchViewState>();
  const [error, setError] = useState('');
  const [dropping, setDropping] = useState(false);
  useEffect(() => { api.state().then(setState, e => setError(errorText(e))); return api.subscribe(setState); }, []);
  const run: Run = useCallback(async task => { setError(''); try { return await task(); } catch (e) { setError(errorText(e)); } }, []);
  if (!state) return error ? <div className="batch"><p className="batch-error" role="alert">{error}</p></div> : null;
  const running = state.batch?.phase === 'running' || state.batch?.phase === 'reverting';
  const accepts = (event: DragEvent) => !running && event.dataTransfer.types.includes('Files');
  const drop = (event: DragEvent) => { event.preventDefault(); setDropping(false); const files = Array.from(event.dataTransfer.files); if (files.length && !running) void run(() => api.add(files)); };
  return <div className={`batch ${dropping ? 'dropping' : ''}`} onDragOver={event => { if (accepts(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDragEnter={event => { if (accepts(event)) setDropping(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropping(false); }} onDrop={drop}>
    {!state.native && <div className="preview-banner">Browser preview with sample files. Run Clop to optimise real files.</div>}
    {state.batch ? <Results key={state.batch.id} batch={state.batch} run={run}/> : <Prepare state={state} run={run}/>}
    {state.pendingAdd !== undefined && <Sheet label="Start a new batch?" onClose={() => void run(() => api.cancelAdd())}>
      <h2>Start a new batch with the {plural(state.pendingAdd, 'dropped item')}?</h2>
      <p>This batch can still be reverted. Starting a new one keeps its backups, and you can open it again with Open previous batch to give its originals back.</p>
      <div className="sheet-actions"><button type="button" autoFocus onClick={() => void run(() => api.cancelAdd())}>Keep this batch</button><button type="button" className="primary" onClick={() => void run(() => api.confirmAdd())}>Start new batch</button></div>
    </Sheet>}
    {state.pendingReopen !== undefined && <Sheet label="Open the previous batch?" onClose={() => void run(() => api.cancelAdd())}>
      <h2>Open the previous batch and drop the {plural(state.pendingReopen, 'prepared file')}?</h2>
      <p>The files you prepared here are removed from the window. You can drop them again afterwards.</p>
      <div className="sheet-actions"><button type="button" autoFocus onClick={() => void run(() => api.cancelAdd())}>Keep these files</button><button type="button" className="primary" onClick={() => void run(() => api.confirmAdd())}>Open previous batch</button></div>
    </Sheet>}
    {error && <div className="batch-error" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss message" onClick={() => setError('')}><Icon name="close" size={12}/></button></div>}
  </div>;
}

function Prepare({ state, run }: { state: BatchViewState; run: Run }) {
  const [params, setParams] = useState<BatchParams>(state.defaults);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const files = useMemo(() => state.files.filter(file => !removed.has(file.path)), [state.files, removed]);
  // Files dropped on an empty window start from the settings again, aggressive or not; later states leave the user's choices alone.
  const empty = !state.files.length;
  useEffect(() => { if (!empty) { setParams(state.defaults); setRemoved(new Set()); } }, [empty]);
  const columns = useMemo(() => ({ name: (f: BatchFile) => f.path.split(/[\\/]/).pop()!, type: (f: BatchFile) => `${KIND_ORDER[f.kind]}${f.format}`, size: (f: BatchFile) => f.bytes }), []);
  const { sorted, header } = useSort(files, columns, 'name');
  const selection = useSelection(sorted.map(file => file.path));
  const present = useMemo(() => new Set(files.map(file => file.kind)), [files]);
  const remove = () => { if (selection.selected.size) { setRemoved(new Set([...removed, ...selection.selected])); selection.clear(); } };
  const start = () => run(() => api.start(files.map(file => file.path), params));
  const previous = state.previous && <button type="button" onClick={() => void run(() => api.reopen(state.previous!.id))}>Open previous batch ({plural(state.previous.files, 'file')})</button>;
  if (state.scanning && empty) return <div className="batch-centre"><span className="spinner"/>Scanning…</div>;
  if (empty) return <><div className="drop-zone"><Icon name="drop" size={52}/><strong>Drop files and folders here</strong><span>Images, videos, PDFs and audio are added; everything else is ignored. Drop more anytime to keep adding.</span></div><Footer><span className="muted">No files</span>{state.notices.length > 0 && <span className="hint">{state.notices.join(' ')}</span>}<span className="spacer"/>{previous}<button type="button" onClick={() => void run(() => api.close())}>Close</button><button type="button" className="primary" disabled>Optimise</button></Footer></>;
  return <>
    <div className="table-wrap" tabIndex={0} onKeyDown={event => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); } }}>
      <table className="files" aria-label="Files to optimise" aria-multiselectable="true">
        <thead><tr>{header('name', 'Name')}{header('type', 'Type', 'narrow')}{header('size', 'Size', 'narrow number')}</tr></thead>
        <tbody>{sorted.map(file => <tr key={file.path} aria-selected={selection.selected.has(file.path)} className={selection.selected.has(file.path) ? 'selected' : ''} onClick={event => selection.click(file.path, event)}>
          <td title={file.path}>{file.path.split(/[\\/]/).pop()}</td><td className="muted">{file.format}</td><td className="number muted">{humanBytes(file.bytes)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <ParamCards params={params} onChange={setParams} present={present} cropSizes={state.cropSizes} audioFormats={state.audioFormats} chooseFolder={() => api.chooseFolder()}/>
    <Footer>
      <span className="muted">{plural(files.length, 'file')}{state.scanning ? ' · scanning…' : ''}</span>
      <span className="hint">Drop to add more; select and press Delete to remove files.{state.notices.map(notice => ` ${notice}`)}{params.aggressive ? ' Aggressive optimisation.' : ''}</span>
      <span className="spacer"/>
      {selection.selected.size > 0 && <button type="button" onClick={remove}>Remove {plural(selection.selected.size, 'file')}</button>}
      {previous}
      <button type="button" onClick={() => void run(() => api.clear())}>Reset</button>
      <button type="button" onClick={() => void run(() => api.close())}>Cancel</button>
      <button type="button" className="primary" disabled={!files.length || state.scanning} onClick={() => void start()}>Optimise</button>
    </Footer>
  </>;
}

function Footer({ children }: { children: ReactNode }) { return <footer className="batch-footer">{children}</footer>; }

function StatusCell({ item }: { item: BatchItem }) {
  switch (item.status) {
    case 'running': return item.progress ? <progress aria-label={`${item.name} progress`} value={item.progress} max={1}/> : <span className="spinner" aria-label="Optimising"/>;
    case 'done': return <span className="status done" title={item.unchanged ? 'Already as small as it gets' : 'Optimised'}><Icon name="check" size={14}/></span>;
    case 'reverted': return <span className="status reverted" title="Original restored"><Icon name="restore" size={14}/></span>;
    case 'failed': return <span className="status failed" title={item.error}>!</span>;
    case 'queued': return <span className="status queued" title="Waiting">…</span>;
    case 'skipped': return <span className="status skipped" title="Skipped"><Icon name="minus" size={14}/></span>;
  }
}
const dims = (size?: { width: number; height: number }) => size && size.width ? `${size.width}×${size.height}` : undefined;
function detail(item: BatchItem) {
  if (item.status === 'failed') return item.error ?? 'Failed';
  const pair = (old?: string, now?: string) => old && now && old !== now ? `${old} → ${now}` : now ?? old ?? '';
  if (item.kind === 'pdf') return pair(item.oldDetail ? `${item.oldDetail}` : undefined, item.newDetail ? `${item.newDetail}` : undefined) + (item.oldDetail || item.newDetail ? ' DPI' : '');
  if (item.kind === 'audio') return pair(item.oldDetail ? `${item.oldDetail}` : undefined, item.newDetail ? `${item.newDetail}` : undefined) + (item.oldDetail || item.newDetail ? ' kbps' : '');
  return pair(dims(item.oldSize), dims(item.newSize));
}
const finished = (item: BatchItem) => item.status === 'done' && item.newBytes !== undefined;

function Results({ batch, run }: { batch: BatchSnapshot; run: Run }) {
  const [failures, setFailures] = useState<BatchFailure[]>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState('');
  const columns = useMemo(() => ({
    status: (i: BatchItem) => STATUS_ORDER[i.status] * 10 + KIND_ORDER[i.kind], name: (i: BatchItem) => i.name, format: (i: BatchItem) => i.oldFormat,
    size: (i: BatchItem) => i.oldBytes, saved: (i: BatchItem) => finished(i) ? savedPercent(i.oldBytes, i.newBytes) ?? 0 : -1000, details: (i: BatchItem) => detail(i),
  }), []);
  const { sorted, header } = useSort(batch.items, columns, 'status');
  const selection = useSelection(sorted.map(item => item.path));
  const counts = { done: 0, failed: 0, skipped: 0, reverted: 0, running: 0, queued: 0 };
  let oldBytes = 0, newBytes = 0;
  for (const item of batch.items) { counts[item.status]++; oldBytes += item.oldBytes; newBytes += finished(item) ? item.newBytes! : item.oldBytes; }
  const total = batch.items.length, done = total - counts.running - counts.queued, saved = Math.max(0, oldBytes - newBytes);
  const running = batch.phase === 'running', busy = running || batch.phase === 'reverting';
  const canRevert = !busy && !batch.backupsDeleted && batch.items.some(item => item.status === 'done' && !item.unchanged);
  const selectedItems = sorted.filter(item => selection.selected.has(item.path));
  const reveal = (item: BatchItem) => run(() => api.reveal(item.result ?? item.path));
  const revert = () => run(async () => { const problems = await api.revert(batch.id); setNotice(problems.length ? problems.join('\n') : 'The originals are back.'); });
  return <>
    <div className="table-wrap">
      <table className="results" aria-label="Batch results" aria-multiselectable="true">
        <thead><tr>{header('status', <span className="visually-hidden">Status</span>, 'status-col')}{header('name', 'Name')}{header('format', 'Format', 'narrow')}{header('size', 'Size', 'number')}{header('saved', 'Saved', 'narrow number')}{header('details', 'Details')}</tr></thead>
        <tbody>{sorted.map(item => {
          const pct = finished(item) ? savedPercent(item.oldBytes, item.newBytes) : undefined;
          return <tr key={item.path} aria-selected={selection.selected.has(item.path)} className={`${selection.selected.has(item.path) ? 'selected' : ''} ${item.status}`} onClick={event => selection.click(item.path, event)} onDoubleClick={() => void reveal(item)}>
            <td className="status-col"><StatusCell item={item}/></td>
            <td title={item.result && item.result !== item.path ? `${item.path}\n→ ${item.result}` : item.path}>{item.name}</td>
            <td className={item.newFormat && item.newFormat !== item.oldFormat ? '' : 'muted'}>{item.newFormat && item.newFormat !== item.oldFormat ? `${item.oldFormat} → ${item.newFormat}` : item.oldFormat}</td>
            <td className={`number ${finished(item) ? '' : 'muted'}`}>{finished(item) && !item.unchanged ? `${humanBytes(item.oldBytes)} → ${humanBytes(item.newBytes!)}` : humanBytes(item.oldBytes)}</td>
            <td className={`number ${pct === undefined ? '' : pct > 0 ? 'good' : pct < 0 ? 'bad' : 'muted'}`}>{pct === undefined ? '' : pct > 0 ? `−${pct}%` : pct < 0 ? `+${-pct}%` : '0%'}</td>
            <td className={item.status === 'failed' ? 'warn' : 'muted'} title={item.status === 'failed' ? item.error : undefined}>{detail(item)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="controls-bar">
      {running ? <span className="progress"><progress aria-label="Batch progress" value={done} max={total}/><span>{done}/{total}</span></span>
        : <span className={`summary ${counts.failed ? 'warn' : 'good'}`}>{batch.phase === 'reverted' ? `${counts.reverted} reverted` : batch.phase === 'reverting' ? 'Reverting…' : `${counts.done} done`}{counts.failed ? `, ${counts.failed} failed` : ''}{counts.skipped ? `, ${counts.skipped} skipped` : ''}</span>}
      {saved > 0 && <span className="pills"><span className="pill bad">{humanBytes(oldBytes)}</span><Icon name="arrow" size={11}/><span className="pill good">{humanBytes(newBytes)}</span><span className="pill good strong">−{Math.round(saved / oldBytes * 100)}%</span></span>}
      {batch.backupsDeleted && <span className="muted">Backups deleted; the originals can no longer be restored.</span>}
      <span className="spacer"/>
      <button type="button" disabled={!running} onClick={() => void run(() => api.cancel(batch.id))}>Cancel</button>
    </div>
    {notice && <div className="batch-notice" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss" onClick={() => setNotice('')}><Icon name="close" size={12}/></button></div>}
    <Footer>
      <button type="button" disabled={selectedItems.length !== 1} onClick={() => void reveal(selectedItems[0])}>Show in Explorer</button>
      {counts.failed > 0 && <button type="button" className="warn-button" onClick={() => void run(async () => setFailures(await api.failures(batch.id)))}>{counts.failed} failed</button>}
      <span className="spacer"/>
      <button type="button" disabled={!canRevert} onClick={() => void revert()}>Revert originals</button>
      <button type="button" disabled={batch.backupsDeleted} onClick={() => void run(() => api.reveal(batch.backups))}>Show backups</button>
      <button type="button" className="danger" disabled={busy || batch.backupsDeleted} onClick={() => setConfirmDelete(true)}>Delete backups</button>
      <button type="button" className="primary" disabled={busy} onClick={() => void run(() => api.clear())}>New batch</button>
    </Footer>
    {confirmDelete && <Sheet label="Delete the backups for this batch?" onClose={() => setConfirmDelete(false)}>
      <h2>Delete the backups for this batch?</h2>
      <p>Clop keeps the original of every file it replaced so the batch can be reverted. Deleting the backups frees that space, but these originals can no longer be restored from Clop.</p>
      <div className="sheet-actions"><button type="button" onClick={() => setConfirmDelete(false)}>Keep backups</button><button type="button" className="danger" onClick={() => { setConfirmDelete(false); void run(() => api.deleteBackups(batch.id)); }}>Delete backups</button></div>
    </Sheet>}
    {failures && <Failures failures={failures} onClose={() => setFailures(undefined)}/>}
  </>;
}

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [onClose]);
  return <div className="sheet-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="sheet" role="dialog" aria-modal="true" aria-label={label}>{children}</div></div>;
}

/** BatchFailuresSheet: each failed file with its reason and, when a tool failed, its output. */
function Failures({ failures, onClose }: { failures: BatchFailure[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = failures.map(f => `## ${f.path}\n${f.error}${f.log ? `\n\n${f.log}` : ''}`).join('\n\n———\n\n');
  return <Sheet label="Failed files" onClose={onClose}>
    <h2 className="warn">{plural(failures.length, 'file')} failed</h2>
    <ul className="failures">{failures.map(f => <li key={f.path}><details><summary><strong>{f.name}</strong><span>{f.error}</span></summary>{f.log ? <pre>{f.log}</pre> : <p className="muted">No tool output was captured for this failure.</p>}</details></li>)}</ul>
    <div className="sheet-actions"><button type="button" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))}>{copied ? 'Copied' : 'Copy'}</button><span className="spacer"/><button type="button" className="primary" autoFocus onClick={onClose}>Done</button></div>
  </Sheet>;
}
