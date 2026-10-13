import { hintFor, shortcutsFor } from '../core/shortcuts';
import type { ClopSettings } from '../core/settings/schema';
import { describeAccelerator } from './settings/accelerator';

/**
 * The first-run card (spec step 41): where Clop lives and the keys that matter, once. It shows until dismissed, which sets
 * `finishedOnboarding`. The keys are read from the settings, so they are the ones that really work (none when the shortcuts are off).
 */
export function Welcome({ settings, onDismiss }: { settings: ClopSettings; onDismiss(): void }) {
  const shortcuts = shortcutsFor(settings), key = (kind: Parameters<typeof hintFor>[1]) => hintFor(shortcuts, kind);
  const optimise = key('optimiseClipboard'), pause = key('pause'), batch = key('aggressive');
  return <section className="welcome-card" aria-label="Welcome to Clop">
    <strong>Welcome to Clop</strong>
    <p>Clop lives in the tray, by the clock: right-click its icon for the menu. Copy or drop files and Clop shrinks them.</p>
    {(optimise || pause || batch) && <ul>
      {optimise && <li><kbd>{describeAccelerator(optimise)}</kbd> optimise the clipboard now</li>}
      {batch && <li><kbd>{describeAccelerator(batch)}</kbd> optimise the clipboard harder</li>}
      {pause && <li><kbd>{describeAccelerator(pause)}</kbd> pause or resume</li>}
    </ul>}
    <button onClick={onDismiss}>Got it</button>
  </section>;
}
