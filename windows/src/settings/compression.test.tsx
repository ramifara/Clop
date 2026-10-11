import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import React, { type ReactElement, type ReactNode } from 'react';
import { defaultSettings, type ClopSettings } from '../../core/settings/schema';

(globalThis as { window?: unknown }).window = {};
const { SettingsContext } = await import('./context');
const { Compression } = await import('./media');

/** Just enough of React's hook dispatcher to call a function component and run its effects, without a DOM. */
function mount(component: () => ReactNode, context: unknown) {
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
/** The element with this text among a returned tree's children. */
function find(node: ReactNode, text: string): ReactElement {
  const hit = (n: ReactNode): ReactElement | undefined => {
    if (Array.isArray(n)) return n.map(hit).find(Boolean);
    if (!React.isValidElement(n)) return undefined;
    const props = n.props as { children?: ReactNode };
    return props.children === text ? n : hit(props.children);
  };
  const found = hit(node);
  assert.ok(found, text);
  return found;
}

test('picking a video encoder tier cancels a factor change that is still waiting to be saved', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const changes: Partial<ClopSettings>[] = [];
    const settings = { ...defaultSettings(), videoCompression: { tier: 'smaller', factor: 40 } } as ClopSettings;
    const context = { settings, change: (partial: Partial<ClopSettings>) => { changes.push(partial); } };
    // `Compression` is a function component: call it as React would.
    const hooked = mount(() => Compression({ settingKey: 'videoCompression' }), context);
    let tree = hooked.render();
    // The slider moves; before it is saved the user picks Adaptive.
    const slider = (function findSlider(n: ReactNode): ReactElement | undefined {
      if (Array.isArray(n)) return n.map(findSlider).find(Boolean);
      if (!React.isValidElement(n)) return undefined;
      const props = n.props as { type?: string; children?: ReactNode };
      return props.type === 'range' ? n : findSlider(props.children);
    })(tree)!;
    (slider.props as { onChange(event: { target: { value: string } }): void }).onChange({ target: { value: '80' } });
    tree = hooked.render();
    (find(tree, 'Adaptive').props as { onClick(): void }).onClick();
    mock.timers.tick(1000);
    assert.deepEqual(changes, [{ videoCompression: { tier: 'adaptive', factor: 40 } }]);
  } finally { mock.timers.reset(); }
});
