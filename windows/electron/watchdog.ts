// Hang detection (spec step 40), which replaces `ErrorReports.swift`: nothing is reported anywhere; a hang is logged, and the user is
// offered a reload of the window that stopped responding. The state machine is pure (it takes the time and returns what to do) so it
// is tested without Electron; `main.ts` feeds it the windows' `unresponsive` and `responsive` events and a timer.

export type WatchdogAction =
  | { kind: 'log'; level: 'info' | 'warn'; text: string }
  | { kind: 'offer-reload'; window: string }
  | { kind: 'withdraw-offer'; window: string };

export interface WatchdogOptions {
  /** How often `sample` is called. */
  intervalMs?: number;
  /** Extra delay of a sample that counts as the main process being blocked. */
  lagMs?: number;
  /** After the user chose to wait, how long before the same window is offered a reload again. */
  cooldownMs?: number;
  /** The least time between two blocked-loop log lines, so a long stall logs once. */
  logEveryMs?: number;
}

export class Watchdog {
  private readonly interval: number; private readonly lag: number; private readonly cooldown: number; private readonly logEvery: number;
  private hung = new Map<string, { since: number; offered: boolean; label: string }>();
  private waited = new Map<string, number>();
  private lastSample: number | undefined;
  private lastLag = -Infinity;
  constructor({ intervalMs = 500, lagMs = 2000, cooldownMs = 60_000, logEveryMs = 10_000 }: WatchdogOptions = {}) {
    this.interval = intervalMs; this.lag = lagMs; this.cooldown = cooldownMs; this.logEvery = logEveryMs;
  }

  /** The window `id` (called `label` in messages) stopped responding. Offers a reload unless it is already offered, or the user chose to wait a moment ago. */
  unresponsive(id: string, at: number, label = id): WatchdogAction[] {
    if (this.hung.has(id)) return [];
    const waitedAt = this.waited.get(id), offer = waitedAt === undefined || at - waitedAt >= this.cooldown;
    this.hung.set(id, { since: at, offered: offer, label });
    return [{ kind: 'log', level: 'warn', text: `The ${label} window is not responding.` }, ...(offer ? [{ kind: 'offer-reload' as const, window: id }] : [])];
  }

  /** The window `id` responds again: the offer, if still open, is withdrawn. */
  responsive(id: string, at: number): WatchdogAction[] {
    const hang = this.hung.get(id);
    if (!hang) return [];
    this.hung.delete(id);
    return [{ kind: 'log', level: 'info', text: `The ${hang.label} window responds again after ${at - hang.since} ms.` }, ...(hang.offered ? [{ kind: 'withdraw-offer' as const, window: id }] : [])];
  }

  /** The user answered the offer with "wait": the window is not offered again for a while. */
  declined(id: string, at: number) { this.waited.set(id, at); }

  /** The window `id` was reloaded or closed; its hang is over. */
  closed(id: string) { this.hung.delete(id); this.waited.delete(id); }

  /** Called every `intervalMs` by a timer in the main process: a call that arrives much later than that means the process was blocked. */
  sample(at: number): WatchdogAction[] {
    const previous = this.lastSample;
    this.lastSample = at;
    if (previous === undefined) return [];
    const late = at - previous - this.interval;
    if (late < this.lag || at - this.lastLag < this.logEvery) return [];
    this.lastLag = at;
    return [{ kind: 'log', level: 'warn', text: `The main process was blocked for about ${Math.round(late / 100) / 10} s.` }];
  }
}
