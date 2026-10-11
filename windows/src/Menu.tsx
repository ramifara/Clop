import { useState } from 'react';
import type { Invocation, MenuNode } from '../core/cards/actions';

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
    {submenu && open && <div className="submenu"><MenuView nodes={submenu} onInvoke={onInvoke} label={label}/></div>}
  </li>;
}
