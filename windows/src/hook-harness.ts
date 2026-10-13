import assert from 'node:assert/strict';
import React, { type ReactElement, type ReactNode } from 'react';

/** Just enough of React's hook dispatcher to call a function component and run its effects, without a DOM. */
export function mount(component: () => ReactNode, context: unknown) {
  const slots: unknown[] = [], effects: { deps?: unknown[]; cleanup?: unknown }[] = [];
  let cursor = 0, pending: (() => void)[] = [];
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useContext: () => context,
    useState: (initial: unknown) => { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [slots[at], (next: unknown) => { slots[at] = next; }]; },
    useRef: (initial: unknown) => { const at = cursor++; if (!(at in slots)) slots[at] = { current: initial }; return slots[at]; },
    useCallback: (fn: unknown, deps: unknown[]) => { const at = cursor++, held = slots[at] as { fn: unknown; deps: unknown[] } | undefined; if (held && held.deps.length === deps.length && held.deps.every((dep, i) => Object.is(dep, deps[i]))) return held.fn; slots[at] = { fn, deps }; return fn; },
    useEffect: (fn: () => unknown, deps: unknown[]) => {
      const at = cursor++, held = effects[at];
      if (held && deps && held.deps && held.deps.every((dep, i) => Object.is(dep, deps[i]))) return;
      pending.push(() => { (held?.cleanup as (() => void) | undefined)?.(); effects[at] = { deps, cleanup: fn() }; });
    },
  };
  return {
    render() {
      cursor = 0; internals.H = dispatcher;
      try { return component() as ReactElement; } finally { internals.H = null; const run = pending; pending = []; run.forEach(effect => effect()); }
    },
  };
}
/** The first element in a returned tree whose props match. */
export function findBy(node: ReactNode, match: (props: Record<string, unknown>) => boolean): ReactElement | undefined {
  if (Array.isArray(node)) return node.map(child => findBy(child, match)).find(Boolean);
  if (!React.isValidElement(node)) return undefined;
  const props = node.props as Record<string, unknown>;
  return match(props) ? node : findBy(props.children as ReactNode, match);
}
/** The element with this text among a returned tree's children. */
export function find(node: ReactNode, text: string): ReactElement {
  const found = findBy(node, props => props.children === text);
  assert.ok(found, text);
  return found;
}
