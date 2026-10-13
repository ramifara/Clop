import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Invocation, MenuNode } from '../core/cards/actions';

/** Keeps a menu on screen: the popup moves up or left from where it was asked for until it fits. */
export function MenuPopup({ at, children }: { at: { x: number; y: number }; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(at);
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setPlace({ x: Math.max(4, Math.min(at.x, window.innerWidth - box.width - 4)), y: Math.max(4, Math.min(at.y, window.innerHeight - box.height - 4)) });
  }, [at]);
  return <div ref={ref} className="menu-popup" style={{ left: place.x, top: place.y }}>{children}</div>;
}

/** A submenu opens to the right of its entry, or to the left and higher up when there is no room. */
function Submenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left?: string; right?: string; top: number }>({ top: -5 });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const overflow = Math.max(0, box.bottom - window.innerHeight + 4);
    setPlace({ top: -5 - Math.min(overflow, Math.max(0, box.top - 4)), ...(box.right > window.innerWidth - 4 ? { left: 'auto', right: 'calc(100% - 4px)' } : {}) });
  }, []);
  return <div ref={ref} className="submenu" style={place}>{children}</div>;
}

/**
 * A menu model as HTML: the browser preview's right-click menu, since a native menu needs the desktop app. Submenus open to the
 * side on hover or focus; headers and separators group the entries as the native menu does.
 */
export function MenuView({ nodes, onInvoke, label = 'Actions' }: { nodes: MenuNode[]; onInvoke: (invocation: Invocation) => void; label?: string }) {
  return <ul className="html-menu" role="menu" aria-label={label}>{nodes.map((node, index) => <MenuRow key={index} node={node} onInvoke={onInvoke}/>)}</ul>;
}
function MenuRow({ node, onInvoke }: { node: MenuNode; onInvoke: (invocation: Invocation) => void }) {
  const [open, setOpen] = useState(false);
  if ('separator' in node) return <li className="menu-separator" role="separator"/>;
  if ('header' in node) return <li className="menu-header" role="presentation">{node.header}</li>;
  const { label, invoke, submenu, enabled = true, checked, hint } = node, usable = enabled && (!!invoke || !!submenu);
  return <li role="none" className={submenu ? 'has-submenu' : ''} onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}>
    <button role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} aria-haspopup={submenu ? 'menu' : undefined} aria-expanded={submenu ? open : undefined} disabled={!usable}
      title={hint && hint.length > 6 ? hint : undefined} onClick={() => { if (invoke) onInvoke(invoke); else setOpen(value => !value); }}>
      <span className="menu-check">{checked ? '✓' : ''}</span><span className="menu-label">{label}</span>{hint && hint.length <= 6 ? <kbd>{hint}</kbd> : submenu ? <span className="menu-arrow">›</span> : null}
    </button>
    {submenu && open && <Submenu><MenuView nodes={submenu} onInvoke={onInvoke} label={label}/></Submenu>}
  </li>;
}
