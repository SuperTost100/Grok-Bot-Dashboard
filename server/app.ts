import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "./config.ts";
import { READ_SCOPES, type Store, type Item, type ItemInput, type Kind, type Section, type Option, type Draft, type Action, type Bot, type PanelBlock, type ReadScope } from "./store.ts";
import { addDays, lastSlot, localStamp, overlaps, parseWhen, snoozeChoices, zonedToEpoch } from "./time.ts";
import { checkWebhookUrl } from "./webhook.ts";
import { GROUPS, SettingError, Settings } from "./settings.ts";
import type { Triage } from "./triage.ts";
import type { Phone } from "./ntfy.ts";
import { weekStart } from "./wakes.ts";
import { hashToken, type Addons } from "./addons/manager.ts";
import { ASKS } from "./addons/manifest.ts";
import { askJev, type Question } from "./jev.ts";
import type { AddonRow, InboxInput } from "./store.ts";

/** A route result sent as-is instead of as JSON, like an image. */
class Raw {
  type: string;
  data: Buffer;
  constructor(type: string, data: Buffer) {
    this.type = type;
    this.data = data;
  }
}

// Errors with a status code become JSON error responses; anything else is a 500.
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const bad = (msg: string) => new HttpError(400, msg);
const conflict = (msg: string) => new HttpError(409, msg);

// ---------- Input checks for what bots send ----------

function text(v: unknown, field: string, max: number, required = false): string {
  if (v == null || v === "") {
    if (required) throw bad(`"${field}" is required`);
    return "";
  }
  if (typeof v !== "string") throw bad(`"${field}" must be a string`);
  const s = v.trim();
  if (required && !s) throw bad(`"${field}" is required`);
  if (s.length > max) throw bad(`"${field}" is longer than ${max} characters`);
  return s;
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`"${field}" must be an object`);
  return v as Record<string, unknown>;
}

function slug(v: unknown): string {
  const s = text(v, "bot", 32, true).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) throw bad(`"bot" must be a short id like "dashboard" (letters, digits, dashes)`);
  return s;
}

/** A short app id like "whatsapp". Bots get this wrong often, so it's normalized rather than rejected. */
function app(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40);
}

function url(v: unknown, field: string): string {
  const s = text(v, field, 2000);
  if (s && !/^https?:\/\/[^\s]+$/i.test(s)) throw bad(`"${field}" must be an http:// or https:// link`);
  return s;
}

function when(v: unknown, field: string, tz: string, required: boolean): string {
  const s = text(v, field, 40, required);
  if (!s) return "";
  const out = parseWhen(s, tz);
  if (!out) throw bad(`"${field}" must be a real date like 2026-10-12 or 2026-10-12T14:30:00+02:00, got "${s}"`);
  return out;
}

const KINDS: Kind[] = ["choice", "draft", "reminder", "digest"];

/** The names PoliTO's and the calendar's cards and events have always used, now the PoliTO app's and the Calendar add-on's. */
export const POLITO_BOT = "polito";
export const CALENDAR_OWNER = "calendar";

/**
 * The to-dos worth showing today: overdue, due or with a deadline in the next 7 days,
 * plus anything p1 or p2. Sorted by the nearest date, then priority.
 */
export function pickTodos<T extends { due: string; deadline: string; priority: number }>(todos: T[], today: string, limit = 30) {
  const horizon = addDays(today, 7);
  const nearest = (t: T) => [t.due.slice(0, 10), t.deadline].filter(Boolean).sort()[0] ?? "";
  const shown = todos
    .filter((t) => {
      const d = nearest(t);
      return (d && d <= horizon) || t.priority <= 2;
    })
    .sort((a, b) => {
      const da = nearest(a) || "9999";
      const db = nearest(b) || "9999";
      return da === db ? a.priority - b.priority : da < db ? -1 : 1;
    });
  return { todos: shown.slice(0, limit), hidden: todos.length - Math.min(shown.length, limit) };
}

/**
 * What stays in Needs you: questions with answers, drafts, anything urgent, and taps in progress.
 * Everything else a bot or triage posts there (news, reminders, PoliTO notices) reads as a catch-up line.
 */
export function needsYou(i: Item, awaitingGrok: Set<number> = new Set()): boolean {
  if (i.section !== "needs") return false;
  if (i.status === "pending" || (i.status === "closed" && i.closedReason === "action")) return true;
  return i.kind === "choice" || i.kind === "draft" || i.urgent !== "" || awaitingGrok.has(i.id);
}

const MAX_IMAGE = 300_000;

/** What an add-on without trust may call: its own cards, panel, actions, agenda, to-dos and status. */
const UNTRUSTED_OK = [
  /^\/api\/bot\/(help|items|items\/close|panel|actions|actions\/\d+|agenda|todos)$/,
  /^\/api\/addon\/status$/,
];

/** A panel from a bot or add-on: a title and up to 20 blocks the page knows how to draw. */
export function parsePanel(b: Record<string, unknown>): { title: string; blocks: PanelBlock[] } {
  if (!Array.isArray(b.blocks) || b.blocks.length > 20) throw bad(`"blocks" must be a list of up to 20 blocks`);
  const list = (v: unknown, field: string, max: number) => {
    if (!Array.isArray(v) || v.length > max) throw bad(`"${field}" must be a list of up to ${max}`);
    return v;
  };
  const blocks = (b.blocks as unknown[]).map((raw, i): PanelBlock => {
    const at = `blocks[${i}]`;
    const x = obj(raw, at);
    switch (x.type) {
      case "text": return { type: "text", text: text(x.text, `${at}.text`, 1000, true) };
      case "stats":
        return { type: "stats", items: list(x.items, `${at}.items`, 6).map((r, n) => { const o = obj(r, `${at}.items[${n}]`); return { label: text(o.label, `${at}.items[${n}].label`, 40, true), value: text(String(o.value ?? ""), `${at}.items[${n}].value`, 40, true) }; }) };
      case "list":
        return {
          type: "list",
          items: list(x.items, `${at}.items`, 30).map((r, n) => {
            const o = obj(r, `${at}.items[${n}]`);
            const f = `${at}.items[${n}]`;
            return { title: text(o.title, `${f}.title`, 200, true), sub: text(o.sub, `${f}.sub`, 200), link: url(o.link, `${f}.link`), badge: text(o.badge, `${f}.badge`, 30) };
          }),
        };
      case "table": {
        const columns = list(x.columns, `${at}.columns`, 8).map((c, n) => text(c, `${at}.columns[${n}]`, 40, true));
        const rows = list(x.rows, `${at}.rows`, 50).map((r, n) => list(r, `${at}.rows[${n}]`, columns.length).map((c, k) => text(String(c ?? ""), `${at}.rows[${n}][${k}]`, 200)));
        return { type: "table", columns, rows };
      }
      case "buttons":
        return {
          type: "buttons",
          items: list(x.items, `${at}.items`, 4).map((r, n) => {
            const o = typeof r === "string" ? { label: r } : obj(r, `${at}.items[${n}]`);
            return { label: text(o.label, `${at}.items[${n}].label`, 60, true), instruction: text(o.instruction, `${at}.items[${n}].instruction`, 1000) };
          }),
        };
      case "image": {
        const src = text(x.src, `${at}.src`, MAX_IMAGE, true);
        // Only inline images: the page never loads anything from elsewhere.
        if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(src)) throw bad(`"${at}.src" must be a base64 data: image (png or jpeg)`);
        return { type: "image", src, alt: text(x.alt, `${at}.alt`, 200, true) };
      }
      default:
        throw bad(`"${at}.type" must be text, stats, list, table, buttons or image`);
    }
  });
  return { title: text(b.title, "title", 80), blocks };
}

export function parseItem(raw: unknown, i = 0, tz = "UTC"): ItemInput {
  const at = (f: string) => (i ? `items[${i}].${f}` : f);
  const b = obj(raw, i ? `items[${i}]` : "item");
  if (b.section != null && b.section !== "needs" && b.section !== "catchup") throw bad(`"${at("section")}" must be "needs" or "catchup"`);
  const section: Section = b.section === "catchup" || (b.section == null && b.kind === "digest") ? "catchup" : "needs";
  const kind = (b.kind ?? (section === "catchup" ? "digest" : "reminder")) as Kind;
  if (!KINDS.includes(kind)) throw bad(`"${at("kind")}" must be one of ${KINDS.join(", ")}`);
  if (section === "needs" && kind === "digest") throw bad(`kind "digest" belongs in section "catchup"`);
  if (section === "catchup" && kind !== "digest") throw bad(`section "catchup" only takes kind "digest". Questions go in "needs".`);
  let options: Option[] = [];
  if (b.options != null) {
    if (!Array.isArray(b.options) || b.options.length > 4) throw bad(`"${at("options")}" must be a list of up to 4 answers`);
    options = b.options.map((o, n) => {
      const opt = typeof o === "string" ? { label: o } : obj(o, at(`options[${n}]`));
      return { label: text(opt.label, at(`options[${n}].label`), 60, true), instruction: text(opt.instruction, at(`options[${n}].instruction`), 1000) };
    });
  }
  if (kind === "choice" && options.length < 1) throw bad(`a "choice" needs at least one entry in "options"`);
  if (kind !== "choice" && options.length) throw bad(`"options" only work on kind "choice"`);
  let draft: Draft | null = null;
  if (kind === "draft") {
    const d = obj(b.draft, at("draft"));
    draft = { to: text(d.to, at("draft.to"), 80, true), channel: text(d.channel, at("draft.channel"), 40), text: text(d.text, at("draft.text"), 4000, true) };
  }
  // A day without a time runs out at the end of that day.
  const expires = when(b.expires, at("expires"), tz, false);
  const expiresAt = !expires ? null : zonedToEpoch(expires.length === 10 ? `${addDays(expires, 1)}T00:00:00` : expires, tz);
  return {
    bot: slug(b.bot),
    key: text(b.key, at("key"), 200) || null,
    section,
    kind,
    title: text(b.title, at("title"), 200, true),
    // Long enough for an exam timetable from PoliTO; the page scrolls long tables inside the card.
    body: text(b.body, at("body"), 10_000),
    context: text(b.context, at("context"), 1000),
    source: text(b.source, at("source"), 120),
    app: app(b.app),
    link: url(b.link, at("link")),
    urgent: text(b.urgent, at("urgent"), 60),
    countLabel: text(b.countLabel, at("countLabel"), 40),
    options,
    draft,
    expiresAt,
    reopen: b.reopen === true,
  };
}

// ---------- Static files ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * The gateway address of every network this container is on (Docker gives each bridge network's gateway
 * the subnet's first address). Read from /proc/net/route, refreshed every minute.
 */
let gatewayCache: { at: number; set: Set<string> } | null = null;
export function gateways(routeTable?: string): Set<string> {
  if (!routeTable && gatewayCache && Date.now() - gatewayCache.at < 60_000) return gatewayCache.set;
  let table = routeTable ?? "";
  if (!routeTable) {
    try {
      table = fs.readFileSync("/proc/net/route", "utf8");
    } catch {
      table = "";
    }
  }
  const ip = (hex: string) => [0, 1, 2, 3].map((i) => parseInt(hex.slice(6 - i * 2, 8 - i * 2), 16)).join(".");
  const set = new Set<string>();
  for (const line of table.split("\n").slice(1)) {
    const [, dest, gw, , , , , mask] = line.trim().split(/\s+/);
    if (!dest || !mask) continue;
    if (gw && gw !== "00000000") set.add(ip(gw));
    if (mask !== "00000000") {
      const base = (parseInt(dest, 16) & parseInt(mask, 16)) >>> 0;
      // Little-endian: the first address of the subnet adds 1 to the lowest-addressed byte, the last one here.
      set.add(ip(((base + 0x01000000) >>> 0).toString(16).padStart(8, "0")));
    }
  }
  if (!routeTable) gatewayCache = { at: Date.now(), set };
  return set;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const MAX_BODY = 512 * 1024;

// ---------- The app ----------

export interface AppDeps {
  config: Config;
  store: Store;
  settings?: Settings;
  /** Read on every request: main.ts swaps them when their settings change. */
  /** WhatsApp, mail and calendars the dashboard reads itself. */
  /** Jev sorting the messages the sources read. */
  triage?: Triage | null;
  phone?: Phone | null;
  addons?: Addons | null;
  notify?: (bot: string, reason: "actions" | "refresh" | "inbox" | "work") => void;
  /** The last webhook ping to a bot and whether its routine accepted it. */
  lastPing?: (bot: string) => { at: number; ok: boolean } | undefined;
  log?: (msg: string) => void;
}

const RECENT_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
/** How long something stays on the page after you first saw it: news a day, questions three days. */
export const INFO_TTL_MS = DAY_MS;
export const CARD_TTL_MS = 3 * DAY_MS;
const MAX_AWAY_DAYS = 60;
export const STALE_CLAIM_MS = 20 * 60_000;
// A scheduled run or an accepted ping that hasn't reached the dashboard after this long means the bot can't get here.
export const OFFLINE_AFTER_MS = 20 * 60_000;

export function createApp(deps: AppDeps) {
  const { config, store } = deps;
  const settings = deps.settings ?? new Settings(store, config, {});
  const tz = config.tz;
  const notify = deps.notify ?? (() => {});
  const log = deps.log ?? ((m: string) => console.log(m));
  const undoMs = () => settings.int("undoSeconds") * 1000;
  const today = () => localStamp(new Date(store.now()), tz).slice(0, 10);

  /** The scheduled run and the accepted ping a bot missed since it last showed up (empty while it's on time). */
  function missed(b: Bot): number[] {
    const now = store.now();
    // With triage on, the Grok bot runs only when woken: its old run times no longer mean anything.
    const schedule = deps.triage?.active() && b.slug === settings.str("grokBot") ? [] : b.schedule;
    const slot = lastSlot(now - OFFLINE_AFTER_MS, schedule, tz);
    const ping = deps.lastPing?.(b.slug);
    return [slot, ping?.ok && now - ping.at > OFFLINE_AFTER_MS ? ping.at : null].filter((t): t is number => t !== null && t > (b.lastSeenAt ?? 0));
  }
  const offlineSince = (b: Bot) => (missed(b).length ? Math.min(...missed(b)) : null);

  function uiItem(i: Item) {
    const a = i.status === "pending" ? store.pendingActionFor(i.id) : null;
    return {
      ...i,
      pendingAction: a
        ? { id: a.id, type: a.type, label: a.label, instruction: a.instruction, text: a.text, status: a.status, runAfter: a.runAfter }
        : null,
    };
  }

  /** To-dos from add-ons (Todoist) replace the lists Grok bots send, as a calendar add-on replaces their agenda. */
  async function todosState() {
    const kinds = new Map(store.listBots().map((b) => [b.slug, b.kind]));
    const all = store.listTodos().filter((t) => !t.completedAt);
    const fromAddons = all.filter((t) => (kinds.get(t.bot) ?? "bot") !== "bot");
    const list = fromAddons.length ? fromAddons : all;
    if (!list.length) return { source: "none", items: [], hidden: 0, error: "" };
    const { todos, hidden } = pickTodos(list, today());
    return { source: fromAddons.length ? "addon" : "bot", items: todos, hidden, error: "" };
  }

  function awayView() {
    const a = store.getAway();
    if (!a) return null;
    const active = store.isAway();
    return { from: a.from, until: a.until, active, back: !active && a.until <= store.now() && !a.summarized };
  }

  /**
   * When the page's content was last brought up to date. With triage on, add-ons read the sources
   * itself, so their reads count and the Grok bot's old scans (it no longer scans) don't.
   */
  function lastUpdate(bots: Bot[]): number | null {
    const triageOn = Boolean(deps.triage?.active());
    const scans = bots.filter((b) => !(triageOn && b.slug === settings.str("grokBot"))).map((b) => b.lastScanAt);
    scans.push(Number(store.getState("sources:lastRead") ?? 0) || null);
    const known = scans.filter((t): t is number => t !== null);
    return known.length ? Math.max(...known) : null;
  }

  function botView(b: Bot, busy: Set<string>) {
    const offline = offlineSince(b);
    return {
      slug: b.slug, name: b.name, color: b.color, lastScanAt: b.lastScanAt, lastSeenAt: b.lastSeenAt,
      refreshRequestedAt: b.refreshRequestedAt, hasWebhook: Boolean(b.webhookUrl), offlineSince: offline,
      kind: b.kind, shown: b.shown, role: b.role, reads: b.reads,
      status: offline ? "offline" : busy.has(b.slug) ? "working" : "idle",
    };
  }

  function panelView(p: ReturnType<Store["listPanels"]>[number]) {
    const owner = store.getBot(p.owner);
    return { ...p, name: owner?.name ?? p.owner, color: owner?.color ?? "", kind: owner?.kind ?? "bot" };
  }

  async function state() {
    store.wakeSnoozed();
    store.expireClaims(STALE_CLAIM_MS);
    // Nothing expires while you're away, and the clock restarts when you're back.
    if (!store.isAway()) store.expireStale({ infoMs: INFO_TTL_MS, cardMs: CARD_TTL_MS, clockFrom: store.getAway()?.until ?? 0 });
    const items = store.activeItems(RECENT_MS).map(uiItem);
    const awaiting = store.awaitingGrok();
    const day = today();
    const bots = store.listBots();
    const busy = store.busyBots();
    return {
      now: store.now(),
      today: day,
      tz,
      undoSeconds: settings.int("undoSeconds"),
      archiveDays: settings.int("archiveDays"),
      snoozeChoices: snoozeChoices(store.now(), tz),
      bots: bots.map((b) => botView(b, busy)),
      pinned: store.listPanels().filter((p) => p.pinned).map(panelView),
      panelActions: store.openPanelActions().map((a) => ({ id: a.id, bot: a.bot, label: a.label, status: a.status, runAfter: a.runAfter })),
      lastScanAt: lastUpdate(bots),
      needs: items.filter((i) => needsYou(i, awaiting)),
      catchup: items.filter((i) => !needsYou(i, awaiting)),
      away: awayView(),
      todos: await todosState(),
      agenda: agenda(day),
      sourceProblems: store.listAddons().filter((a) => a.enabled && !a.statusOk && a.status).map((a) => `${(a.manifest as { name: string }).name}: ${a.status}`),
      runs: { week: store.allWakesSince(weekStart(store.now(), tz)), cap: settings.int("weeklyRuns") },
    };
  }

  function agenda(day: string) {
    const events = store.listEvents(day, addDays(day, 2));
    // The Calendar add-on replaces the agenda Grok bots send.
    // Add-ons, apps and PoliTO always add their own events, like deadlines.
    const calendarRead = Boolean(store.getAddon(CALENDAR_OWNER)?.enabled);
    const kinds = new Map(store.listBots().map((b) => [b.slug, b.kind]));
    return events.filter((e) => {
      if (e.bot === CALENDAR_OWNER) return calendarRead;
      if (e.bot === POLITO_BOT) return true;
      if ((kinds.get(e.bot) ?? "bot") !== "bot") return true;
      return !calendarRead;
    });
  }

  function itemOr404(id: string) {
    const item = store.getItem(Number(id));
    if (!item || (item.status === "closed" && !item.title)) throw new HttpError(404, "No card with that id. It may have been archived.");
    return item;
  }

  /** Card management (done, snooze...) can cancel a tap still waiting, but not one the bot already took. */
  function freeFromBot(item: Item) {
    const a = store.pendingActionFor(item.id);
    if (a?.status === "claimed") throw conflict(`${item.bot} is already doing "${a.label}". Wait for it to finish.`);
  }

  /** You closed a card: an add-on or app that owns it hears about it, so PoliTO can mark a notice read there too. */
  function closedByYou(item: Item, reason: "done" | "dismissed" | "read") {
    const owner = store.getBot(item.bot);
    if (owner && (owner.kind === "addon" || owner.kind === "app")) {
      store.addAction({ bot: owner.slug, type: "closed", label: reason, text: item.key ?? `#${item.id}`, delayMs: 0 });
    }
  }

  async function act(item: Item, b: Record<string, unknown>) {
    const type = text(b.type, "type", 20, true);
    const outward = (fields: { type: "choose" | "send" | "write"; label: string; instruction?: string; text?: string }) => {
      // No bot stands behind PoliTO cards, so there's nobody to send an answer to.
      if (item.bot === POLITO_BOT) throw bad("PoliTO cards can only be marked as read, snoozed or dismissed.");
      if (Number(b.rev) !== item.rev) {
        throw conflict("This card changed since you opened it. Check it again before answering.");
      }
      // A read catch-up summary can still take a follow-up question.
      if (item.status === "closed" && !(!needsYou(item) && item.closedReason === "read" && fields.type === "write")) throw conflict("This card is already closed.");
      if (item.status === "snoozed") throw conflict("This card is snoozed. Restore it first.");
      if (store.pendingActionFor(item.id)) throw conflict("The bot is already working on this card.");
      return store.addAction({ item, bot: item.bot, delayMs: undoMs(), ...fields });
    };
    switch (type) {
      case "choose": {
        if (item.kind !== "choice") throw bad("Only choice cards have answers to pick.");
        const n = Number(b.option);
        const opt = item.options[n];
        if (!opt) throw bad("Unknown option.");
        if (b.label !== undefined && b.label !== opt.label) throw conflict("The answers on this card changed. Check it again.");
        return { action: outward({ type: "choose", label: opt.label, instruction: opt.instruction }) };
      }
      case "send": {
        if (item.kind !== "draft" || !item.draft) throw bad("Only draft cards can be sent.");
        const edited = text(b.text, "text", 4000);
        return { action: outward({ type: "send", label: `Send to ${item.draft.to}`, text: edited || item.draft.text }) };
      }
      case "write": {
        const msg = text(b.text, "text", 2000, true);
        return { action: outward({ type: "write", label: msg, text: msg }) };
      }
      case "done":
        freeFromBot(item);
        closedByYou(item, "done");
        return { item: store.closeItem(item.id, "done", item.bot === POLITO_BOT ? "Read" : "Marked done") };
      case "dismiss":
        freeFromBot(item);
        closedByYou(item, "dismissed");
        return { item: store.closeItem(item.id, "dismissed", "Dismissed") };
      case "read":
        if (needsYou(item, store.awaitingGrok())) throw bad("Only catch-up lines can be marked as read.");
        closedByYou(item, "read");
        return { item: store.closeItem(item.id, "read", "Read") };
      case "snooze": {
        freeFromBot(item);
        const until = typeof b.until === "number" ? b.until : Date.parse(String(b.until));
        if (!Number.isFinite(until) || until <= store.now()) throw bad(`"until" must be a time in the future`);
        return { item: store.snoozeItem(item.id, until) };
      }
      case "restore":
        if (store.pendingActionFor(item.id)) throw conflict("The bot is working on this card.");
        if (item.closedReason === "action") throw conflict("The bot already did this one.");
        return { item: store.reopenItem(item.id) };
      default:
        throw bad(`Unknown action "${type}".`);
    }
  }

  async function completeTodo(bot: string, id: string, undo: boolean) {
    const todo = store.findTodo(bot, id);
    if (!todo) throw new HttpError(404, "No to-do with that id.");
    const pending = store.pendingTodoAction(bot, id);
    if (undo) {
      if (!pending) {
        if (todo.completedAt) throw conflict("Too late to undo: the bot already completed it.");
        return { ok: true };
      }
      if (!store.cancelAction(pending.id)) throw conflict("Too late to undo: the bot already has it.");
      return { ok: true };
    }
    if (pending || todo.completedAt) throw conflict("This to-do is already being completed.");
    store.setTodoCompleted(bot, id, true);
    const action = store.addAction({ todoId: id, todoDue: todo.due, bot, type: "complete_todo", label: todo.content, delayMs: undoMs() });
    return { ok: true, action };
  }

  function actionForBot(a: Action) {
    if (a.type === "closed") return { id: a.id, type: a.type, key: a.text, reason: a.label };
    if (a.type === "refresh") return { id: a.id, type: a.type };
    return {
      id: a.id,
      type: a.type,
      label: a.label,
      instruction: a.instruction,
      text: a.text,
      todoId: a.todoId,
      // The card exactly as the user saw it when they tapped.
      card: a.itemId ? a.snapshot : null,
      // Grok Bot's auto-review holds sends to recipients it hasn't seen approved. This line is the approval it looks for.
      approved: `The user tapped this on the dashboard at ${localStamp(new Date(a.createdAt), tz)}. The tap is their approval for exactly this action, including sending the message: do it now without asking them again.`,
    };
  }

  function botHelp() {
    return {
      now: localStamp(new Date(store.now()), tz),
      timeZone: tz,
      today: today(),
      undoSeconds: settings.int("undoSeconds"),
      cards: {
        post: "POST /api/bot/items with one card or {\"items\": [...]} (up to 50). Same bot + key updates the card.",
        fields: {
          key: "stable id of the decision, like wa:<chat id>:<message id>. Up to 200 chars.",
          kind: "choice | draft | reminder (section needs), digest (section catchup)",
          title: "required, up to 200 chars, what's needed",
          body: "up to 10000 chars", context: "up to 1000 chars", source: "label like 'WhatsApp · Lab group', up to 120 chars",
          app: "whatsapp, gmail, googlecalendar, mail, github, todoist, subito, vinted, telegram... (shows the logo)",
          link: "http(s) link to the original", urgent: "deadline words like 'answer by 14:00', up to 60 chars",
          options: "choice only: 1 to 4 of {label (up to 60 chars), instruction (up to 1000)}. The instruction must do exactly what the label says.",
          draft: "draft only: {to, channel, text}", countLabel: "digest only, like '46 messages'",
          reopen: "true to bring back a card the user closed",
          expires: "date or time after which the card is out of date (the event it's about has happened), like 2026-10-16 or 2026-10-16T21:00:00+02:00. The card goes to the archive then.",
        },
        example: { key: "wa:120363@g.us:poll-7", kind: "choice", app: "whatsapp", source: "WhatsApp · Lab group", title: "Marco needs your vote on the lab swap", urgent: "answer by 14:00", options: [{ label: "Vote Tuesday", instruction: "Vote Tuesday in the Lab group poll" }] },
        list: "GET /api/bot/items?status=open|closed|all", close: "POST /api/bot/items/close {key, reason}",
      },
      inbox: "GET /api/bot/actions also returns inbox: work the dashboard's triage handed you, each with key, task, source, app, chat, urgent, need and messages (isNew marks the new ones). task card: post one card with that exact key, kind choice with 2 to 4 answers or kind draft with a reply; if it needs nothing after all, close the key. task calendar: do what instruction says in the user's main calendar, then close the key with what you did. Never send anything yourself.",
      actions: {
        take: "GET /api/bot/actions claims every waiting action. Do each one once, using its id to avoid doing it twice.",
        report: "POST /api/bot/actions/<id> {ok: true|false, result: 'one line'}. Report every action you took.",
        types: { choose: "do instruction (or label)", send: "send text exactly to card.draft.to on card.draft.channel", write: "text is the user's instruction about the card", complete_todo: "complete to-do todoId", panel: "the user pressed a button on your panel: do instruction (or label)" },
      },
      agenda: "PUT /api/bot/agenda {from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' (default from + 2 days), app, events: [{title, start, end, location, allDay}]}. It REPLACES all your events overlapping from..to, so always send the complete list for that window.",
      todos: "PUT /api/bot/todos {app, todos: [{id, content, priority: 'p1'..'p4', due, dueString, deadline, project, url}]}. It REPLACES your whole list.",
      scan: "POST /api/bot/scan {startedAt: 'YYYY-MM-DDTHH:MM:SS', schedule?: ['08:00', ...]} after a full scan where every source was read, with the time the scan began (the 'now' from grokdash actions). GET /api/bot/actions returns lastScanAt: scan for messages since then. schedule is your daily run times: when one passes without you, the page says you're offline.",
      status: "GET /api/bot/status: {offline, offlineSince, lastMissedAt, lastSeenAt, schedule}. For a watchdog; it doesn't count as the bot checking in.",
      register: "POST /api/bot/register {name, color, webhookUrl, webhookToken}",
    };
  }

  // ----- routing -----

  type Handler = (req: http.IncomingMessage, params: string[], query: URLSearchParams, body: Record<string, unknown>) => unknown;
  const routes: { method: string; re: RegExp; scope: "bot" | "ui"; fn: Handler }[] = [];
  const route = (method: string, pattern: string, scope: "bot" | "ui", fn: Handler) =>
    routes.push({ method, re: new RegExp("^" + pattern.replace(/:\w+/g, "([^/]+)") + "$"), scope, fn });

  // Bot API

  route("GET", "/api/bot/help", "bot", () => botHelp());

  route("POST", "/api/bot/register", "bot", (_r, _p, _q, b) => {
    let webhookUrl: string | undefined;
    if (b.webhookUrl !== undefined) {
      webhookUrl = text(b.webhookUrl, "webhookUrl", 2000);
      const problem = webhookUrl ? checkWebhookUrl(webhookUrl, config.webhookAllowPrivate) : "";
      if (problem) throw bad(problem);
    }
    const bot = store.updateBot(slug(b.bot), {
      name: b.name === undefined ? undefined : text(b.name, "name", 40, true),
      color: b.color === undefined ? undefined : text(b.color, "color", 20),
      webhookUrl,
      webhookToken: b.webhookToken === undefined ? undefined : text(b.webhookToken, "webhookToken", 500),
    });
    // Never echo secrets back.
    return { bot: { slug: bot.slug, name: bot.name, color: bot.color, webhookUrl: bot.webhookUrl ? "set" : "", webhookToken: bot.webhookToken ? "set" : "" } };
  });

  route("POST", "/api/bot/items", "bot", (_r, _p, _q, b) => {
    const batch = Array.isArray(b.items);
    const list = batch ? (b.items as unknown[]) : [b];
    if (list.length > 50) throw bad("Send at most 50 items per call.");
    const parsed = list.map((x, i) => parseItem(x && typeof x === "object" && !Array.isArray(x) ? { ...x, bot: b.bot } : x, batch ? i : 0, tz));
    const keys = parsed.map((p) => p.key).filter(Boolean);
    if (new Set(keys).size !== keys.length) throw bad("Two items in this call share a key. Send each key once.");
    const results = parsed.map((p) => {
      const r = store.upsertItem(p);
      if (p.key && p.bot === settings.str("grokBot")) deps.triage?.ack(p.key);
      return { id: r.item.id, key: r.item.key, status: r.item.status, created: r.created, reopened: r.reopened, ignored: r.ignored };
    });
    return batch ? { results } : results[0];
  });

  route("GET", "/api/bot/items", "bot", (_r, _p, q) => {
    const status = q.get("status") ?? "open";
    if (!["open", "pending", "snoozed", "closed", "all"].includes(status)) throw bad(`"status" must be open, pending, snoozed, closed or all`);
    const section = q.get("section");
    if (section && section !== "needs" && section !== "catchup") throw bad(`"section" must be needs or catchup`);
    return {
      items: store.listItems({ bot: slug(q.get("bot")), section: (section as Section) || undefined, status: status as "open" }).map((i) => ({
        id: i.id, key: i.key, section: i.section, kind: i.kind, title: i.title, status: i.status, closedReason: i.closedReason, resolution: i.resolution, updatedAt: i.updatedAt,
      })),
    };
  });

  route("POST", "/api/bot/items/close", "bot", (_r, _p, _q, b) => {
    const bot = slug(b.bot);
    const item = b.id != null ? store.getItem(Number(b.id)) : store.getItemByKey(bot, text(b.key, "key", 200, true));
    if (!item || item.bot !== bot) throw new HttpError(404, "No item with that id or key for this bot.");
    if (store.pendingActionFor(item.id)?.status === "claimed") throw conflict("You hold an action on this card. Report it instead of closing the card.");
    const closed = store.closeItem(item.id, "bot", text(b.reason, "reason", 200) || "Closed by the bot");
    if (item.key && bot === settings.str("grokBot")) deps.triage?.ack(item.key);
    return { id: closed!.id, status: closed!.status };
  });

  route("PUT", "/api/bot/agenda", "bot", (_r, _p, _q, b) => {
    const bot = slug(b.bot);
    if (!Array.isArray(b.events) || b.events.length > 200) throw bad(`"events" must be a list of up to 200 events`);
    const from = b.from ? when(b.from, "from", tz, true).slice(0, 10) : today();
    const to = b.to ? when(b.to, "to", tz, true).slice(0, 10) : addDays(from, 2);
    if (to <= from) throw bad(`"to" must be after "from"`);
    const events = (b.events as unknown[]).map((raw, i) => {
      const e = obj(raw, `events[${i}]`);
      const start = when(e.start, `events[${i}].start`, tz, true);
      const end = when(e.end, `events[${i}].end`, tz, false);
      if (end && end < start) throw bad(`events[${i}] ends before it starts`);
      if (!overlaps(start, end, from, to)) {
        throw bad(`events[${i}] (${start}) is outside ${from} to ${to}. Send only events in that window, or widen "from" and "to".`);
      }
      return {
        title: text(e.title, `events[${i}].title`, 200, true),
        start,
        end,
        location: text(e.location, `events[${i}].location`, 200),
        allDay: e.allDay === true || start.length === 10,
        app: app(e.app ?? b.app),
      };
    });
    store.replaceEvents(bot, from, to, events);
    if (store.getBot(bot)?.kind !== "bot") store.setState("sources:lastRead", String(store.now()));
    return { from, to, stored: events.length };
  });

  route("PUT", "/api/bot/todos", "bot", (_r, _p, _q, b) => {
    const bot = slug(b.bot);
    if (!Array.isArray(b.todos) || b.todos.length > 500) throw bad(`"todos" must be a list of up to 500 to-dos`);
    const todos = (b.todos as unknown[]).map((raw, i) => {
      const t = obj(raw, `todos[${i}]`);
      const priority = Number(String(t.priority ?? "p4").toLowerCase().replace(/^p/, ""));
      if (![1, 2, 3, 4].includes(priority)) throw bad(`todos[${i}].priority must be p1, p2, p3 or p4`);
      if (t.duration !== undefined && !(Number(t.duration) >= 0 && Number(t.duration) <= 1440)) throw bad(`todos[${i}].duration must be minutes, 0 to 1440`);
      return {
        id: text(String(t.id ?? ""), `todos[${i}].id`, 100, true),
        content: text(t.content, `todos[${i}].content`, 300, true),
        priority,
        due: when(t.due, `todos[${i}].due`, tz, false),
        dueString: text(t.dueString, `todos[${i}].dueString`, 80),
        deadline: when(t.deadline, `todos[${i}].deadline`, tz, false).slice(0, 10),
        project: text(t.project, `todos[${i}].project`, 80),
        url: url(t.url, `todos[${i}].url`),
        app: app(t.app ?? b.app),
        duration: t.duration === undefined ? 0 : Math.round(Number(t.duration)),
      };
    });
    if (new Set(todos.map((t) => t.id)).size !== todos.length) throw bad("Two to-dos share an id. Send each id once.");
    store.replaceTodos(bot, todos);
    if (store.getBot(bot)?.kind !== "bot") store.setState("sources:lastRead", String(store.now()));
    return { stored: todos.length };
  });

  route("GET", "/api/bot/actions", "bot", (_r, _p, q) => {
    const bot = slug(q.get("bot"));
    store.touchBot(bot);
    store.expireClaims(STALE_CLAIM_MS);
    store.promoteDue(bot);
    const actions = store.claimActions(bot).map(actionForBot);
    const b = store.getBot(bot)!;
    store.setState(`wake:claim:${bot}`, String(store.now()));
    // Work other bots left for this one, and answers to what this one asked of others.
    const handoffs = store.claimHandoffs(bot).map((h) => ({ id: h.id, from: h.from, text: h.text, urgent: h.urgent }));
    const handoffResults = store.takeHandoffResults(bot).map((h) => ({ id: h.id, to: h.to, text: h.text, ok: h.status === "done", result: h.result }));
    // The chats triage queued for this bot ride along with its actions, whatever woke it.
    const inbox = deps.triage?.active() && bot === settings.str("grokBot") ? deps.triage.claimForGrok() : [];
    return {
      actions,
      inbox,
      handoffs,
      handoffResults,
      refreshRequested: Boolean(b.refreshRequestedAt),
      lastScanAt: b.lastScanAt ? localStamp(new Date(b.lastScanAt), tz) : null,
      now: localStamp(new Date(store.now()), tz),
      timeZone: tz,
    };
  });

  // One bot leaves work for another. It reaches the receiver on its next run, which the wake rules schedule.
  route("POST", "/api/bot/handoffs", "bot", (_r, _p, _q, b) => {
    const from = slug(b.bot);
    const to = slug(b.to);
    const target = store.getBot(to);
    if (!target || target.kind === "source") throw new HttpError(404, `No bot called "${to}".`);
    if (to === from) throw bad("A bot can't hand work to itself.");
    const h = store.addHandoff(from, to, text(b.text, "text", 4000, true), b.urgent === true);
    return { id: h.id, to: h.to, status: h.status, canWake: Boolean(target.webhookUrl) };
  });

  route("POST", "/api/bot/handoffs/:id", "bot", (_r, p, _q, b) => {
    if (typeof b.ok !== "boolean") throw bad(`"ok" must be true or false`);
    const h = store.finishHandoff(Number(p[0]), slug(b.bot), b.ok, text(b.result, "result", 2000));
    if (!h) throw new HttpError(404, "No handoff with that id waiting on this bot.");
    return { id: h.id, status: h.status };
  });

  // ----- add-ons and apps (their own token) -----

  route("PUT", "/api/addon/status", "bot", (_r, _p, _q, b) => {
    store.setAddonStatus(slug(b.bot), text(b.text, "text", 200), b.ok !== false);
    return { ok: true };
  });

  // Mail and chat messages as the dashboard received them, after an id the add-on remembers.
  route("GET", "/api/addon/messages", "bot", (_r, _p, q) => {
    const after = Math.max(0, Math.floor(Number(q.get("after") ?? 0)) || 0);
    const limit = Math.min(500, Math.max(1, Math.floor(Number(q.get("limit") ?? 200)) || 200));
    const messages = store.inboxAfter(after, text(q.get("source"), "source", 40), limit);
    return { messages, last: messages.at(-1)?.id ?? after };
  });

  // Messages an add-on or app read (WhatsApp, mail…) go to triage like the dashboard's own.
  route("POST", "/api/addon/messages", "bot", (_r, _p, _q, b) => {
    const sources = b.sources === undefined ? [] : (Array.isArray(b.sources) ? b.sources : null);
    if (!sources || sources.length > 10) throw bad(`"sources" must be a list of up to 10`);
    for (const [i, raw] of sources.entries()) {
      const x = obj(raw, `sources[${i}]`);
      const id = text(x.id, `sources[${i}].id`, 40, true);
      if (!/^[a-z][a-z0-9-]*(:[\w-]+)?$/.test(id)) throw bad(`sources[${i}].id must look like "whatsapp:1" or "mail:2"`);
      const kind = x.kind === "mail" ? "mail" : "chat";
      store.setState(`inbox:source:${id}`, JSON.stringify({ name: text(x.name, `sources[${i}].name`, 40, true), app: app(x.app), kind }));
    }
    if (!Array.isArray(b.messages) || b.messages.length > 500) throw bad(`"messages" must be a list of up to 500`);
    const messages = (b.messages as unknown[]).map((raw, i): InboxInput => {
      const x = obj(raw, `messages[${i}]`);
      const f = (k: string, max: number, req = false) => text(x[k] == null ? "" : String(x[k]), `messages[${i}].${k}`, max, req);
      const source = f("source", 40, true);
      if (!store.getState(`inbox:source:${source}`)) throw bad(`messages[${i}].source "${source}" isn't described in "sources" yet`);
      const at = Number(x.at);
      if (!Number.isFinite(at) || at <= 0) throw bad(`messages[${i}].at must be a time in milliseconds`);
      return {
        source, extId: f("extId", 300, true), thread: f("thread", 300, true), threadName: f("threadName", 200), sender: f("sender", 200),
        fromMe: x.fromMe === true, isGroup: x.isGroup === true, automated: x.automated === true,
        subject: f("subject", 500), text: f("text", 20_000), link: x.link ? url(x.link, `messages[${i}].link`) : "", at,
      };
    });
    store.setState("sources:lastRead", String(store.now()));
    return { added: store.addInbox(messages) };
  });

  // A typed question for Jev, paid from the dashboard's OpenRouter key.
  route("POST", "/api/addon/decide", "bot", async (_r, _p, _q, b) => {
    const key = settings.str("openrouterKey");
    if (!key) throw conflict("No OpenRouter key on the dashboard, so Jev can't answer.");
    const questions = obj(b.questions, "questions") as Record<string, Question>;
    if (Object.keys(questions).length > 10) throw bad("Ask at most 10 questions at a time.");
    const state = obj(b.state, "state");
    if (JSON.stringify(state).length > 40_000) throw bad(`"state" is too long`);
    try {
      return await askJev(key, settings.str("jevModel"), state, questions);
    } catch (err) {
      throw new HttpError(502, `Jev didn't answer: ${(err as Error).message}`);
    }
  });

  route("PUT", "/api/bot/panel", "bot", (_r, _p, _q, b) => {
    const panel = parsePanel(b);
    const p = store.setPanel(slug(b.bot), panel.title, panel.blocks);
    return { owner: p.owner, blocks: p.blocks.length, pinned: p.pinned };
  });

  route("DELETE", "/api/bot/panel", "bot", (_r, _p, _q, b) => {
    store.deletePanel(slug(b.bot));
    return { ok: true };
  });

  // What a bot may read beyond its own cards. You tick it per bot under Settings, Bots.
  route("GET", "/api/bot/read/:what", "bot", async (_r, p, q) => {
    const what = p[0] as ReadScope;
    if (!READ_SCOPES.includes(what)) throw new HttpError(404, `Readable: ${READ_SCOPES.join(", ")}.`);
    const bot = store.getBot(slug(q.get("bot")));
    const legacy = bot?.slug === settings.str("grokBot") || Boolean(store.getAddon(bot?.slug ?? "")?.trusted);
    if (!bot || (!legacy && !bot.reads.includes(what))) throw new HttpError(403, `This bot may not read ${what}. The owner can allow it on the dashboard under Settings, Bots.`);
    if (what === "agenda") return { from: today(), events: agenda(today()) };
    if (what === "todos") return await todosState();
    return { items: store.activeItems(0).filter((i) => i.status !== "closed").map((i) => ({ id: i.id, bot: i.bot, kind: i.kind, title: i.title, body: i.body, source: i.source, urgent: i.urgent, status: i.status })) };
  });

  route("POST", "/api/bot/actions/:id", "bot", (_r, p, _q, b) => {
    if (typeof b.ok !== "boolean") throw bad(`"ok" must be true or false`);
    const r = store.finishAction(Number(p[0]), slug(b.bot), b.ok, text(b.result, "result", 500));
    if (!r.action) throw new HttpError(404, "No action with that id for this bot.");
    if (r.error) throw conflict(r.error);
    return { id: r.action.id, status: r.action.status };
  });

  route("POST", "/api/bot/scan", "bot", (_r, _p, _q, b) => {
    const started = when(b.startedAt, "startedAt", tz, false);
    let schedule: string[] | undefined;
    if (b.schedule !== undefined) {
      if (!Array.isArray(b.schedule) || b.schedule.length > 48 || !b.schedule.every((s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s))) {
        throw bad(`"schedule" must be a list of daily run times like ["08:00", "14:00"].`);
      }
      schedule = [...new Set(b.schedule as string[])].sort();
    }
    store.markScan(slug(b.bot), started ? zonedToEpoch(started.length === 10 ? started + "T00:00:00" : started, tz) : undefined, schedule);
    return { ok: true };
  });

  // For a watchdog on the bot's computer. Reading it doesn't count as the bot showing up.
  route("GET", "/api/bot/status", "bot", (_r, _p, q) => {
    const b = store.getBot(slug(q.get("bot")));
    if (!b) throw new HttpError(404, "No bot with that name has posted yet.");
    const m = missed(b);
    return {
      offline: m.length > 0, offlineSince: m.length ? Math.min(...m) : null, lastMissedAt: m.length ? Math.max(...m) : null,
      lastSeenAt: b.lastSeenAt, schedule: b.schedule,
    };
  });

  // UI API

  route("GET", "/api/ui/state", "ui", () => state());

  route("GET", "/api/ui/archive", "ui", (_r, _p, q) => {
    const offset = Math.max(0, Math.min(10_000, Math.floor(Number(q.get("offset") ?? 0)) || 0));
    const bot = q.get("bot");
    return store.archive(text(q.get("q"), "q", 100), settings.int("archiveDays"), 50, offset, bot && bot !== "all" ? slug(bot) : "");
  });

  route("POST", "/api/ui/items/:id/act", "ui", async (_r, p, _q, b) => {
    const res = await act(itemOr404(p[0]), b);
    return { ...res, state: await state() };
  });

  route("POST", "/api/ui/items/:id/ack", "ui", async (_r, p) => {
    store.ackItem(itemOr404(p[0]).id);
    return { ok: true, state: await state() };
  });

  const idList = (v: unknown) => {
    if (!Array.isArray(v) || v.length > 200 || !v.every((x) => Number.isSafeInteger(x) && x > 0)) throw bad(`"ids" must be a list of up to 200 item ids`);
    return v as number[];
  };

  // The page reports what it showed you, so expiry only counts time you could have seen it.
  route("POST", "/api/ui/seen", "ui", (_r, _p, _q, b) => {
    store.markSeen(idList(b.ids));
    return { ok: true };
  });

  // One catch-up line can stand for several items (a course's PoliTO notices): they're read together.
  route("POST", "/api/ui/read", "ui", async (_r, _p, _q, b) => {
    for (const id of idList(b.ids)) {
      const item = store.getItem(id);
      if (!item || item.status !== "open" || needsYou(item, store.awaitingGrok())) continue;
      closedByYou(item, "read");
      store.closeItem(item.id, "read", "Read");
    }
    return { ok: true, state: await state() };
  });

  route("PUT", "/api/ui/away", "ui", async (_r, _p, _q, b) => {
    // A day means you're away until the end of that day, in the dashboard's time zone.
    const day = typeof b.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.until) ? when(b.until, "until", tz, true) : "";
    const until = day ? zonedToEpoch(`${addDays(day, 1)}T00:00:00`, tz) : typeof b.until === "number" ? b.until : Date.parse(String(b.until ?? ""));
    const now = store.now();
    if (!Number.isFinite(until) || until <= now) throw bad(`"until" must be a time in the future`);
    if (until > now + MAX_AWAY_DAYS * DAY_MS) throw bad(`Away mode lasts at most ${MAX_AWAY_DAYS} days.`);
    store.setAway({ from: store.isAway() ? store.getAway()!.from : now, until, summarized: false });
    return { ok: true, state: await state() };
  });

  route("DELETE", "/api/ui/away", "ui", async () => {
    const a = store.getAway();
    if (a && store.isAway()) store.setAway({ ...a, until: store.now() });
    return { ok: true, state: await state() };
  });

  // You went through what came in while you were away: the summary goes.
  route("POST", "/api/ui/away/summarized", "ui", async () => {
    const a = store.getAway();
    if (a && !store.isAway()) store.setAway({ ...a, summarized: true });
    return { ok: true, state: await state() };
  });

  route("GET", "/api/ui/bots", "ui", () => {
    const busy = store.busyBots();
    const since = weekStart(store.now(), tz);
    const items = store.activeItems(0).filter((i) => i.status !== "closed");
    return {
      bots: store.listBots().filter((b) => b.kind === "bot").map((b) => ({
        ...botView(b, busy),
        panel: store.getPanel(b.slug),
        cards: items.filter((i) => i.bot === b.slug).map((i) => ({ id: i.id, title: i.title, kind: i.kind, urgent: i.urgent, status: i.status })),
        runsThisWeek: store.wakesSince(since, b.slug).length,
        handoffs: store.handoffsOf(b.slug, store.now() - 86_400_000).map((h) => ({ id: h.id, from: h.from, to: h.to, text: h.text, urgent: h.urgent, status: h.status, result: h.result, createdAt: h.createdAt })),
        lastWake: store.wakesSince(since, b.slug).at(-1) ?? null,
      })),
    };
  });

  route("PUT", "/api/ui/bots/:slug", "ui", async (_r, p, _q, b) => {
    const bot = store.getBot(slug(p[0]));
    if (!bot) throw new HttpError(404, "No bot with that name.");
    let reads: ReadScope[] | undefined;
    if (b.reads !== undefined) {
      if (!Array.isArray(b.reads) || !b.reads.every((r) => READ_SCOPES.includes(r as ReadScope))) throw bad(`"reads" must be a list of ${READ_SCOPES.join(", ")}`);
      reads = [...new Set(b.reads as ReadScope[])];
    }
    let webhookUrl: string | undefined;
    if (b.webhookUrl !== undefined) {
      webhookUrl = text(b.webhookUrl, "webhookUrl", 2000);
      const problem = webhookUrl ? checkWebhookUrl(webhookUrl, config.webhookAllowPrivate) : "";
      if (problem) throw bad(problem);
    }
    store.configureBot(bot.slug, {
      shown: b.shown === undefined ? undefined : b.shown === true,
      reads,
      role: b.role === undefined ? undefined : text(b.role, "role", 120),
      webhookUrl,
      // Pasted from the routine panel; "Bearer " in front is dropped, since the dashboard adds it.
      webhookToken: b.webhookToken === undefined ? undefined : text(b.webhookToken, "webhookToken", 500).replace(/^Bearer\s+/i, ""),
    });
    return { ok: true, state: await state() };
  });

  route("POST", "/api/ui/panels/:owner/pin", "ui", async (_r, p, _q, b) => {
    if (!store.getPanel(p[0])) throw new HttpError(404, "No panel with that name.");
    store.pinPanel(p[0], b.pinned === true);
    return { ok: true, state: await state() };
  });

  // A button on a panel: like an answer on a card, it waits out the undo window, then goes to the panel's owner.
  route("POST", "/api/ui/panels/:owner/press", "ui", async (_r, p, _q, b) => {
    const panel = store.getPanel(p[0]);
    if (!panel) throw new HttpError(404, "No panel with that name.");
    const block = panel.blocks[Number(b.block)];
    const button = block?.type === "buttons" ? block.items[Number(b.index)] : undefined;
    if (!button) throw conflict("That button is gone. The panel changed since you opened it.");
    if (b.label !== undefined && b.label !== button.label) throw conflict("The panel changed since you opened it. Check it again.");
    const action = store.addAction({ bot: panel.owner, type: "panel", label: button.label, instruction: button.instruction, delayMs: undoMs() });
    return { action: { id: action.id }, state: await state() };
  });

  // ----- add-ons and apps -----

  const addonsOr404 = () => {
    if (!deps.addons) throw new HttpError(404, "Add-ons are off on this dashboard.");
    return deps.addons;
  };
  /** Errors from GitHub, a manifest or the runner are the user's to read, not server failures. */
  const userError = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw bad((err as Error).message);
    }
  };
  const addonsView = () => {
    const a = addonsOr404();
    return { installed: a.view(), stores: a.stores(), runner: a.runnerOn(), asks: ASKS, panels: Object.fromEntries(a.view().map((x) => [x.id, store.getPanel(x.id)])) };
  };

  route("GET", "/api/ui/addons", "ui", () => addonsView());

  route("GET", "/api/ui/addons/catalog", "ui", async (_r, _p, q) => {
    const c = await addonsOr404().catalog(q.get("refresh") === "1");
    const installed = new Set(addonsOr404().view().map((x) => x.id));
    return { entries: c.entries.map((e) => ({ ...e, installed: installed.has(e.id) })), errors: c.errors };
  });

  route("GET", "/api/ui/addons/peek", "ui", async (_r, _p, q) => userError(() => addonsOr404().peek(text(q.get("source"), "source", 300, true))));

  route("POST", "/api/ui/addons/install", "ui", async (_r, _p, _q, b) => {
    const a = addonsOr404();
    const source = text(b.source, "source", 300, true);
    const values = b.settings === undefined ? {} : obj(b.settings, "settings");
    await userError(() => a.install(source, { trusted: b.trusted === true, settings: values }));
    return { ...addonsView(), state: await state() };
  });

  route("POST", "/api/ui/addons/:id/update", "ui", async (_r, p) => {
    await userError(() => addonsOr404().update(p[0]));
    return addonsView();
  });

  route("PUT", "/api/ui/addons/:id", "ui", async (_r, p, _q, b) => {
    await userError(() => addonsOr404().configure(p[0], {
      trusted: b.trusted === undefined ? undefined : b.trusted === true,
      enabled: b.enabled === undefined ? undefined : b.enabled === true,
      settings: b.settings === undefined ? undefined : obj(b.settings, "settings"),
    }));
    return addonsView();
  });

  route("DELETE", "/api/ui/addons/:id", "ui", async (_r, p, _q, b) => {
    await userError(() => addonsOr404().remove(p[0], b.purge === true));
    return { ...addonsView(), state: await state() };
  });

  route("GET", "/api/ui/addons/:id/logs", "ui", (_r, p) => ({ lines: addonsOr404().logs(p[0]) }));

  route("POST", "/api/ui/addons/stores", "ui", async (_r, _p, _q, b) => {
    const a = addonsOr404();
    const repo = text(b.repo, "repo", 200, true);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw bad(`A store is a GitHub repo like "owner/repo".`);
    a.setStores(b.remove === true ? a.stores().filter((x) => x !== repo) : [...a.stores(), repo]);
    return addonsView();
  });

  route("POST", "/api/ui/addons/check-updates", "ui", async () => {
    await addonsOr404().checkUpdates(true);
    return addonsView();
  });

  route("POST", "/api/ui/actions/:id/undo", "ui", async (_r, p) => {
    if (!store.cancelAction(Number(p[0]))) throw conflict("Too late to undo: the bot already has it.");
    return { ok: true, state: await state() };
  });

  route("POST", "/api/ui/todos/complete", "ui", async (_r, _p, _q, b) => {
    const res = await completeTodo(text(b.bot, "bot", 40, true), text(String(b.id ?? ""), "id", 100, true), b.undo === true);
    return { ...res, state: await state() };
  });

  const settingsView = () => ({
    groups: GROUPS,
    settings: settings.list(),
    status: [...(deps.triage?.status() ?? []), ...(deps.phone ? [deps.phone.status()] : [])],
  });

  route("GET", "/api/ui/settings", "ui", () => settingsView());

  route("PUT", "/api/ui/settings", "ui", (_r, _p, _q, b) => {
    const values = obj(b.values, "values");
    try {
      settings.update(values);
    } catch (err) {
      if (err instanceof SettingError) throw bad(err.message);
      throw err;
    }
    return settingsView();
  });

  route("POST", "/api/ui/refresh", "ui", async () => {
    // Add-ons and apps read their sources now. With triage on, the Grok bot isn't asked to scan;
    // other bots still are.
    const triageOn = Boolean(deps.triage?.active());
    const grok = settings.str("grokBot");
    for (const a of store.listAddons()) if (a.enabled) store.addAction({ bot: a.id, type: "refresh", label: "Read now", delayMs: 0 });
    const bots = store.listBots().filter((b) => b.kind === "bot" && !(triageOn && b.slug === grok));
    for (const bot of bots) store.requestRefresh(bot.slug);
    for (const bot of bots) if (bot.webhookUrl) notify(bot.slug, "refresh");
    // Chats still waiting for Grok (say, it missed its last wake) go to it when you press Refresh.
    if (triageOn && deps.triage!.waiting() > 0) {
      deps.triage!.woke();
      notify(grok, "inbox");
    }
    return { ok: true, webhooks: bots.filter((x) => x.webhookUrl).length, state: await state() };
  });

  // ----- auth -----

  function isOwner(req: http.IncomingMessage) {
    // Checked first, so even with AUTH_MODE=none an app can't reach the owner's pages.
    if (config.ownerVia === "gateway" && !gateways().has(String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, ""))) return false;
    if (config.authMode === "none") return true;
    const login = String(req.headers["tailscale-user-login"] ?? "").toLowerCase();
    return login === config.ownerLogin;
  }

  function addonFor(req: http.IncomingMessage): AddonRow | null {
    const m = /^Bearer (\S{20,200})$/.exec(String(req.headers.authorization ?? ""));
    return m ? store.addonByToken(hashToken(m[1])) : null;
  }

  const expected = Buffer.from(`Bearer ${config.botToken}`);
  function isBot(req: http.IncomingMessage) {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  }

  // ----- server -----

  function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
    if (res.headersSent) return res.end();
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extra });
    res.end(json);
  }

  function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY) return Promise.reject(new HttpError(413, "Body too large (max 512 KB)."));
    return new Promise((resolve, reject) => {
      let size = 0;
      let tooBig = false;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) tooBig = true;
        else chunks.push(c);
      });
      req.on("end", () => {
        if (tooBig) return reject(new HttpError(413, "Body too large (max 512 KB)."));
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
          resolve(v);
        } catch {
          reject(bad("Body must be a JSON object."));
        }
      });
      req.on("error", reject);
    });
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    let rel: string;
    try {
      rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    } catch {
      rel = "";
    }
    const file = path.resolve(config.publicDir, rel);
    if (!rel || !file.startsWith(config.publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      ...SECURITY_HEADERS,
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  }

  return async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let pathname = "/";
    try {
      let u: URL;
      try {
        u = new URL(req.url ?? "/", "http://local");
      } catch {
        throw bad("Malformed request path.");
      }
      pathname = u.pathname;
      if (pathname === "/healthz") return send(res, 200, { ok: true });
      const isApi = pathname.startsWith("/api/");
      const scope = pathname.startsWith("/api/bot/") || pathname.startsWith("/api/addon/") ? "bot" : "ui";
      // Grok bots use the bot token. Add-ons and apps use their own, which ties every call to them.
      let addon: AddonRow | null = null;
      if (scope === "bot" && !isBot(req)) {
        addon = addonFor(req);
        if (!addon) throw new HttpError(401, "Missing or wrong bot token (Authorization: Bearer <BOT_TOKEN>).");
        if (!addon.trusted && !UNTRUSTED_OK.some((re) => re.test(pathname))) {
          throw new HttpError(403, "This add-on isn't trusted, so it can only post its own cards, panel, agenda, to-dos and status. The owner can trust it on the Add-ons page.");
        }
      }
      if (pathname.startsWith("/api/addon/") && !addon) throw new HttpError(403, "These routes are for add-ons and apps, with their own token.");
      if (scope === "ui" && !isOwner(req)) throw new HttpError(403, "This dashboard only opens for its owner's Tailscale account.");
      if (!isApi) {
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
        return serveStatic(req, res, pathname);
      }
      // Requiring JSON on writes blocks cross-site form posts: browsers can't send it without a CORS preflight we never answer.
      if (req.method !== "GET" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        throw new HttpError(415, "Send JSON with Content-Type: application/json.");
      }
      for (const r of routes) {
        if (r.method !== req.method || r.scope !== scope) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const body = req.method === "GET" ? {} : await readBody(req);
        // Bots can name themselves once in an X-Bot header instead of in every body.
        const headerBot = req.headers["x-bot"];
        if (addon) {
          // An add-on is always itself, whatever it says.
          body.bot = addon.id;
          u.searchParams.set("bot", addon.id);
        } else if (scope === "bot" && typeof headerBot === "string") {
          if (body.bot === undefined) body.bot = headerBot;
          if (!u.searchParams.has("bot")) u.searchParams.set("bot", headerBot);
        }
        const out = await r.fn(req, m.slice(1), u.searchParams, body);
        if (out instanceof Raw) {
          res.writeHead(200, { "Content-Type": out.type, "Cache-Control": "no-store", ...SECURITY_HEADERS });
          return res.end(out.data);
        }
        return send(res, 200, out);
      }
      throw new HttpError(404, `No route for ${req.method} ${pathname}.`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`error on ${req.method} ${pathname}: ${(err as Error).stack}`);
      if (status === 403 && !pathname.startsWith("/api/")) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
        return res.end("This dashboard only opens for its owner's Tailscale account.");
      }
      return send(res, status, { error: status === 500 ? "Something broke on the server. Check its logs." : (err as Error).message }, status === 413 ? { Connection: "close" } : {});
    }
  };
}
