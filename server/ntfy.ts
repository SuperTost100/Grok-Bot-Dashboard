// Phone pings through ntfy (https://ntfy.sh). A ping never carries card content: ntfy.sh is a
// public server, so it only says what kind of thing waits and how many, and links to the dashboard.
// WhatsApp and mail already notify you about new messages, so the dashboard never pings for those.
// It pings for what nothing else tells you: a PoliTO deadline coming up, a reminder you set coming back.

import type { Store } from "./store.ts";
import type { Settings } from "./settings.ts";
import { localStamp, zonedToEpoch } from "./time.ts";
import { POLITO_BOT } from "./polito.ts";

type Fetch = typeof fetch;

export async function pingPhone(server: string, topic: string, body: string, link: string, fetchImpl: Fetch = fetch) {
  const url = `${server.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Title: "Grok Dash",
      Priority: "high",
      Tags: "bell",
      ...(link ? { Click: link } : {}),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}

/** At most one ping in this long. What comes up meanwhile goes into the next one. */
export const PHONE_GAP_MS = 60 * 60_000;
/** Deadline pings wait for the morning. */
const MORNING_HOUR = 8;
const DAY_MS = 86_400_000;

export type PingKind = "deadline" | "reminder";

const words: Record<PingKind, (n: number) => string> = {
  deadline: (n) => (n === 1 ? "1 deadline is due tomorrow" : `${n} deadlines are due tomorrow`),
  reminder: (n) => (n === 1 ? "1 reminder is back" : `${n} reminders are back`),
};

export function createPhone(o: { store: Store; settings: Settings; tz: string; log: (msg: string) => void; fetch?: Fetch }) {
  const { store, settings, tz, log } = o;
  const waiting = new Map<PingKind, number>();
  let sending = false;

  async function flush() {
    if (!waiting.size || sending) return;
    const topic = settings.str("ntfyTopic");
    // Off, or you're away: nothing is saved up for later either.
    if (!topic || store.isAway()) return void waiting.clear();
    const last = Number(store.getState("phone:lastPing") ?? 0);
    if (store.now() - last < PHONE_GAP_MS) return;
    const body = [...waiting].map(([k, n]) => words[k](n)).join(". ");
    waiting.clear();
    sending = true;
    try {
      await pingPhone(settings.str("ntfyServer") || "https://ntfy.sh", topic, body, settings.str("dashboardUrl"), o.fetch);
      store.setState("phone:lastPing", String(store.now()));
    } catch (err) {
      log(`phone ping failed: ${(err as Error).message}`);
    } finally {
      sending = false;
    }
  }

  /** PoliTO deadlines due tomorrow, each pinged once, from 8:00 the day before. */
  function deadlinesDue() {
    const now = store.now();
    const stamp = localStamp(new Date(now), tz);
    if (Number(stamp.slice(11, 13)) < MORNING_HOUR) return;
    const pinged = new Set<string>(JSON.parse(store.getState("phone:deadlines") ?? "[]"));
    const today = stamp.slice(0, 10);
    const fresh = store
      .listEvents(today, localStamp(new Date(now + 2 * DAY_MS), tz).slice(0, 10))
      .filter((e) => e.bot === POLITO_BOT && e.start.length === 10)
      .filter((e) => zonedToEpoch(`${e.start}T00:00:00`, tz) - now <= DAY_MS && zonedToEpoch(`${e.start}T00:00:00`, tz) > now)
      .map((e) => `${e.start}|${e.title}`)
      .filter((k) => !pinged.has(k));
    if (!fresh.length) return;
    // Only keys from this week are kept, so the list stays small.
    const keep = [...pinged, ...fresh].filter((k) => k.slice(0, 10) >= today);
    store.setState("phone:deadlines", JSON.stringify(keep));
    waiting.set("deadline", (waiting.get("deadline") ?? 0) + fresh.length);
  }

  return {
    ping(kind: PingKind, n = 1) {
      waiting.set(kind, (waiting.get(kind) ?? 0) + n);
      return flush();
    },
    /** Call every minute or so: checks deadlines and sends what waited for the gap. */
    tick() {
      deadlinesDue();
      return flush();
    },
    status() {
      if (!settings.str("ntfyTopic")) return { group: "Phone pings", on: false, ok: true, text: "Off" };
      const last = Number(store.getState("phone:lastPing") ?? 0);
      return {
        group: "Phone pings", on: true, ok: true,
        text: `For deadlines due tomorrow and reminders coming back, never for new messages. ${last ? `Last ping ${localStamp(new Date(last), tz).slice(5, 16).replace("T", " ")}` : "No ping yet"}`,
      };
    },
  };
}

export type Phone = ReturnType<typeof createPhone>;
