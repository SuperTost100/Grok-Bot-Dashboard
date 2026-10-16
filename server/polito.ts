// Course avvisi, school messages and deadlines from PoliTO, read through areadidattica
// (github.com/SuperTost100/areadidattica-cli), a local JSON API over the PoliTO Students app.
// The dashboard checks it at the Dashboard bot's run times and on Refresh. No Grok bot is involved.

import type { Store, ItemInput } from "./store.ts";
import { addDays, localStamp, zonedToEpoch } from "./time.ts";

/** Cards and agenda entries from PoliTO belong to this pseudo-bot. */
export const POLITO_BOT = "polito";

export interface PolitoItem {
  id: string;
  kind: "avviso" | "message";
  course: string | null;
  title: string;
  text: string;
  sentAt: string;
  isRead: boolean;
  urgent: boolean;
  sourceUrl: string | null;
}

export interface PolitoDeadline {
  id: string;
  title: string;
  date: string;
  course: string | null;
  type: string | null;
  url: string | null;
}

type Fetch = typeof fetch;

export class Polito {
  base: string;
  token: string;
  fetch: Fetch;

  constructor(base: string, token: string, fetchImpl: Fetch = fetch) {
    this.base = base.replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
  }

  // A cold /items call fetches every course's notices one at a time, so reads get a minute.
  async call(method: string, path: string, timeoutMs = 60_000) {
    const res = await this.fetch(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.json().then((b: { error?: string }) => b.error ?? "", () => "");
      const hint = res.status === 401 ? " Check AREADIDATTICA_TOKEN." : "";
      throw new Error(`areadidattica answered ${res.status} on ${method} ${path}${detail ? `: ${detail}` : ""}.${hint}`);
    }
    return res.json();
  }

  async unread(): Promise<PolitoItem[]> {
    return ((await this.call("GET", "/items?unread=true")) as { items: PolitoItem[] }).items;
  }

  async deadlines(from: string, to: string): Promise<PolitoDeadline[]> {
    return ((await this.call("GET", `/deadlines?from=${from}&to=${to}`)) as { deadlines: PolitoDeadline[] }).deadlines;
  }

  async markRead(id: string) {
    await this.call("POST", `/items/${encodeURIComponent(id)}/read`, 15_000);
  }
}

const GREETING = /^(buongiorno|buonasera|salve|ciao|gentil[ei]|car[eio]|egregi|dear|hello|hi)\b/i;

/**
 * The first line that says something becomes the card title, so it tells what the avviso is about.
 * The body is what follows that line, or the whole text when the title had to be cut.
 */
function split(text: string): { title: string; body: string } {
  // Table rows (tab-separated cells) never make a title.
  const line = text.split("\n").map((l) => l.trim()).find((l) => l && !l.includes("\t") && !(l.length < 40 && GREETING.test(l))) ?? "";
  if (!line) return { title: "", body: text.trim() };
  if (line.length <= 140) return { title: line, body: text.slice(text.indexOf(line) + line.length).trim() };
  const cut = line.slice(0, 140);
  return { title: cut.slice(0, cut.lastIndexOf(" ") > 80 ? cut.lastIndexOf(" ") : 139).trimEnd() + "…", body: text.trim() };
}

export function politoCard(p: PolitoItem, tz: string): ItemInput {
  const sent = new Date(p.sentAt);
  const { title, body: rest } = split(p.text);
  // Longer than a bot's 2000 characters: an exam timetable shouldn't lose its last rows.
  const body = rest.length > 10_000 ? rest.slice(0, 9999).trimEnd() + "…" : rest;
  return {
    bot: POLITO_BOT,
    key: p.id,
    section: "needs",
    kind: "reminder",
    title: title || p.title.slice(0, 200),
    body,
    // The card's own time is when the dashboard first saw it, so say when PoliTO sent it.
    context: Number.isNaN(sent.getTime())
      ? ""
      : `${p.kind === "avviso" ? "Avviso" : "Messaggio"} del ${sent.toLocaleString("it-IT", { timeZone: tz, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`,
    source: `PoliTO · ${p.course ?? (p.kind === "message" ? "Messaggi" : "Avvisi")}`.slice(0, 120),
    app: "polito",
    link: p.sourceUrl && /^https?:\/\//i.test(p.sourceUrl) ? p.sourceUrl : "",
    urgent: p.urgent ? "Emergenza" : "",
  };
}

/** Deadline cards live next to the avvisi but aren't PoliTO items: nothing to mark read there. */
const DEADLINE_KEY = "deadline-card:";
export const isDeadlineKey = (key: string) => key.startsWith(DEADLINE_KEY);
/** A deadline this close becomes a card in Needs you, not just a line on the agenda. */
const CARD_DAYS = 3;

/** A card for a deadline in the next three days. It leaves on its own once the day is over. */
export function deadlineCard(d: PolitoDeadline, today: string, tz: string): ItemInput {
  const day = d.date.slice(0, 10);
  const days = Math.round((Date.parse(day + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 86_400_000);
  const when = days <= 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due ${new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}`;
  return {
    bot: POLITO_BOT,
    key: `${DEADLINE_KEY}${d.id}`,
    section: "needs",
    kind: "reminder",
    title: d.title.slice(0, 200),
    body: [d.course, d.type].filter(Boolean).join(" · "),
    source: `PoliTO · ${d.course ?? "Scadenze"}`.slice(0, 120),
    app: "polito",
    link: d.url && /^https?:\/\//i.test(d.url) ? d.url : "",
    urgent: when,
    expiresAt: zonedToEpoch(`${addDays(day, 1)}T00:00:00`, tz),
  };
}

export interface PolitoSync {
  /** Bring cards and deadlines in line with PoliTO. Calls that overlap share one run. */
  sync(): Promise<void>;
  /** Mark a card's avviso or message read on PoliTO. Failures are retried by the next sync. */
  markRead(key: string): Promise<void>;
  /** The last sync's error, empty when it worked. */
  error(): string;
}

export function createPolitoSync(polito: Polito, store: Store, tz: string, log: (msg: string) => void): PolitoSync {
  store.updateBot(POLITO_BOT, { name: "PoliTO", color: "#014271" });
  // Not a Grok bot: it never shows on the Bots page or under Settings, Bots.
  store.configureBot(POLITO_BOT, { kind: "source" });
  let running: Promise<void> | null = null;
  let lastError = "";

  async function markRead(key: string) {
    try {
      await polito.markRead(key);
    } catch (err) {
      log(`polito: marking ${key} read failed: ${(err as Error).message}`);
    }
  }

  async function run() {
    const unread = await polito.unread();
    const keys = new Set(unread.map((p) => p.id));
    const retry: string[] = [];
    // Oldest first, so the newest avviso gets the newest card and sorts on top.
    for (const p of unread.toReversed()) {
      const card = store.getItemByKey(POLITO_BOT, p.id);
      // You finished or dismissed it here, but it's still unread there: the mark-read call failed earlier.
      // Only your own taps are retried. A card the sync closed comes back instead, so a feed that
      // briefly left something out can never get it marked read.
      if (card?.status === "closed" && card.closedReason !== "bot") retry.push(p.id);
      else store.upsertItem({ ...politoCard(p, tz), reopen: card?.status === "closed" });
    }
    // Read in the PoliTO app (or on the Portale) since the last check.
    for (const card of store.liveItemsOf(POLITO_BOT)) {
      if (card.key && !isDeadlineKey(card.key) && !keys.has(card.key)) store.closeItem(card.id, "bot", "Read on PoliTO");
    }
    const from = localStamp(new Date(store.now()), tz).slice(0, 10);
    const to = addDays(from, 30);
    const deadlines = await polito.deadlines(from, to);
    store.replaceEvents(
      POLITO_BOT, from, to,
      deadlines
        .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d.date))
        .map((d) => ({ title: d.title.slice(0, 200), start: d.date.slice(0, 10), end: "", location: "", allDay: true, app: "polito" })),
    );
    const soon = addDays(from, CARD_DAYS - 1);
    for (const d of deadlines) {
      if (/^\d{4}-\d{2}-\d{2}/.test(d.date) && d.date.slice(0, 10) <= soon) store.upsertItem(deadlineCard(d, from, tz));
    }
    // Last, a few at a time, so a PoliTO outage can't hold up new avvisi.
    for (const key of retry.slice(0, 10)) await markRead(key);
  }

  return {
    sync() {
      running ??= run()
        .then(() => {
          if (lastError) log("polito: check works again");
          lastError = "";
        })
        .catch((err) => {
          lastError = (err as Error).message;
          log(`polito: check failed: ${lastError}`);
        })
        .finally(() => {
          store.touchBot(POLITO_BOT);
          store.clearRefresh(POLITO_BOT);
          running = null;
        });
      return running;
    },
    markRead,
    error: () => lastError,
  };
}
