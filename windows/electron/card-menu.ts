import type { MenuItemConstructorOptions } from 'electron';
import type { Invocation, MenuNode } from '../core/cards/actions';

/**
 * The native menu for a menu model (core/cards/actions.ts): headers are disabled labels under a separator, a short hint is the
 * key that does the entry's action on the hovered card (shown, not registered), and a click hands the entry's action back.
 */
export function menuTemplate(nodes: MenuNode[], invoke: (invocation: Invocation) => void): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const node of nodes) {
    if ('separator' in node) { if (out.length && out.at(-1)!.type !== 'separator') out.push({ type: 'separator' }); continue; }
    if ('header' in node) { if (out.length && out.at(-1)!.type !== 'separator') out.push({ type: 'separator' }); out.push({ label: node.header, enabled: false }); continue; }
    const { label, enabled = true, checked, hint, submenu, invoke: action } = node;
    out.push({
      label, enabled: enabled && (!!action || !!submenu),
      ...(checked !== undefined ? { type: 'checkbox' as const, checked } : {}),
      ...(hint && hint.length <= 6 ? { accelerator: hint, registerAccelerator: false } : {}),
      ...(submenu ? { submenu: menuTemplate(submenu, invoke) } : {}),
      ...(action ? { click: () => invoke(action) } : {}),
    });
  }
  while (out.at(-1)?.type === 'separator') out.pop();
  return out;
}
