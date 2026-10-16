// When a bot gets woken for work waiting on it: chats triage queued for the Grok bot, and handoffs
// other bots (or add-ons) left for it. Each bot runs on its own clock:
//
// - Urgent work waits a few minutes for more to arrive, then wakes the bot once with everything
//   queued for it, urgent or not. Right after a run, urgent work waits a little longer, so a burst of
//   urgent messages costs one or two runs instead of one each.
// - Other work goes out together, once the oldest piece has waited long enough and the bot hasn't
//   run for that long either.
// - A wake the bot never answered isn't repeated until new work arrives.
// - Past the weekly cap (every bot's runs together), only urgent work wakes a bot.
//
// Your own taps don't wait for any of this: they wake the bot once their undo window is over.

import type { Store, TriageRow } from "./store.ts";
import type { Settings } from "./settings.ts";
import { addDays, localStamp, zonedToEpoch } from "./time.ts";

export interface Work {
  urgent: boolean;
  /** When it started waiting. */
  since: number;
  /** When it last came in or changed: newer than the last wake means the bot hasn't seen it. */
  fresh: number;
}

export interface WakeRules {
  gatherMs: number;
  mergeMs: number;
  waitMs: number;
  overCap: boolean;
}

/** When the bot is due for this work, or null while it isn't. */
export function dueAt(work: Work[], lastWake: number, answeredAt: number, r: WakeRules): number | null {
  if (!work.length) return null;
  // The bot never came for the last wake: only something new is worth another paid run.
  if (lastWake && answeredAt <= lastWake && !work.some((w) => w.fresh > lastWake)) return null;
  // A bot that never ran has no last run to keep a distance from.
  const after = (gap: number) => (lastWake ? lastWake + gap : 0);
  const urgent = work.filter((w) => w.urgent);
  if (urgent.length) return Math.max(Math.min(...urgent.map((w) => w.since)) + r.gatherMs, after(r.mergeMs));
  if (r.overCap) return null;
  return Math.max(Math.min(...work.map((w) => w.since)) + r.waitMs, after(r.waitMs));
}

/** Monday 00:00 in the dashboard's time zone. */
export function weekStart(now: number, tz: string): number {
  const day = localStamp(new Date(now), tz).slice(0, 10);
  const dow = (new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7;
  return zonedToEpoch(`${addDays(day, -dow)}T00:00:00`, tz);
}

export function rules(store: Store, settings: Settings, tz: string): WakeRules {
  return {
    gatherMs: settings.int("wakeGather") * 60_000,
    mergeMs: settings.int("wakeMerge") * 60_000,
    waitMs: settings.int("wakeWait") * 60_000,
    overCap: store.allWakesSince(weekStart(store.now(), tz)) >= settings.int("weeklyRuns"),
  };
}

/** A chat triage queued counts as urgent when Jev rated it "now". */
export const triageWork = (t: TriageRow, nowLevel: number): Work => ({
  urgent: t.level >= nowLevel,
  since: t.queuedAt ?? t.decidedAt,
  fresh: Math.max(t.decidedAt, t.attempts > 0 ? (t.queuedAt ?? 0) : 0),
});

export function handoffWork(store: Store, bot: string): Work[] {
  return store.queuedHandoffs(bot).map((h) => ({ urgent: h.urgent, since: h.createdAt, fresh: h.createdAt }));
}

/** The bot's last run: the newest wake the dashboard sent it, or a wake it's still sending. */
export function lastWakeOf(store: Store, bot: string, attempted = 0): number {
  return Math.max(attempted, store.wakesSince(0, bot).at(-1)?.at ?? 0);
}

/** When the bot last came for its work. */
export function answeredAt(store: Store, bot: string): number {
  return Number(store.getState(`wake:claim:${bot}`) ?? 0);
}

/** The words a wake carries, so the bot knows what it's for before it reads anything. */
export function wakeMessage(store: Store, bot: string, chats: number): string {
  const handoffs = store.queuedHandoffs(bot);
  const parts: string[] = [];
  if (chats) parts.push(`${chats} chat${chats === 1 ? "" : "s"} need${chats === 1 ? "s" : ""} a card with your answer`);
  for (const h of handoffs.slice(0, 5)) parts.push(`${h.urgent ? "urgent " : ""}task from ${h.from}: ${h.text.length > 300 ? h.text.slice(0, 299) + "…" : h.text}`);
  if (handoffs.length > 5) parts.push(`${handoffs.length - 5} more tasks`);
  return `Dashboard work waiting. ${parts.join(". ")}. Run: grokdash actions`;
}
