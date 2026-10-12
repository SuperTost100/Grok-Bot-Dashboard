import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "./config.ts";
import type { Store, Item, ItemInput, Kind, Section, Option, Draft, Action } from "./store.ts";
import { Todoist, pickTodos } from "./todoist.ts";
import { addDays, localStamp, parseWhen, snoozeChoices, zonedToEpoch } from "./time.ts";
import { checkWebhookUrl } from "./webhook.ts";

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

export function parseItem(raw: unknown, i = 0): ItemInput {
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
  return {
    bot: slug(b.bot),
    key: text(b.key, at("key"), 200) || null,
    section,
    kind,
    title: text(b.title, at("title"), 200, true),
    body: text(b.body, at("body"), 2000),
    context: text(b.context, at("context"), 1000),
    source: text(b.source, at("source"), 120),
    app: app(b.app),
    link: url(b.link, at("link")),
    urgent: text(b.urgent, at("urgent"), 60),
    countLabel: text(b.countLabel, at("countLabel"), 40),
    options,
    draft,
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
  todoist?: Todoist | null;
  notify?: (bot: string, reason: "actions" | "refresh") => void;
  log?: (msg: string) => void;
}

const RECENT_MS = 10 * 60_000;
export const STALE_CLAIM_MS = 20 * 60_000;

export function createApp(deps: AppDeps) {
  const { config, store } = deps;
  const todoist = deps.todoist ?? null;
  const tz = config.tz;
  const notify = deps.notify ?? (() => {});
  const log = deps.log ?? ((m: string) => console.log(m));
  const undoMs = config.undoSeconds * 1000;
  const today = () => localStamp(new Date(store.now()), tz).slice(0, 10);

  function uiItem(i: Item) {
    const a = i.status === "pending" ? store.pendingActionFor(i.id) : null;
    return {
      ...i,
      pendingAction: a
        ? { id: a.id, type: a.type, label: a.label, instruction: a.instruction, text: a.text, status: a.status, runAfter: a.runAfter }
        : null,
    };
  }

  async function todosState() {
    if (todoist) {
      try {
        const all = await todoist.list();
        const { todos, hidden } = pickTodos(all, today());
        return { source: "todoist", items: todos.map((t) => ({ ...t, bot: "todoist", app: "todoist" })), hidden, error: "" };
      } catch (err) {
        return { source: "todoist", items: [], hidden: 0, error: (err as Error).message };
      }
    }
    const fromBots = store.listTodos();
    if (!fromBots.length) return { source: "none", items: [], hidden: 0, error: "" };
    const { todos, hidden } = pickTodos(fromBots.filter((t) => !t.completedAt), today());
    return { source: "bot", items: todos, hidden, error: "" };
  }

  async function state() {
    store.wakeSnoozed();
    store.expireClaims(STALE_CLAIM_MS);
    const items = store.activeItems(RECENT_MS).map(uiItem);
    const day = today();
    const bots = store.listBots();
    return {
      now: store.now(),
      today: day,
      tz,
      undoSeconds: config.undoSeconds,
      snoozeChoices: snoozeChoices(store.now(), tz),
      bots: bots.map((b) => ({ slug: b.slug, name: b.name, color: b.color, lastScanAt: b.lastScanAt, refreshRequestedAt: b.refreshRequestedAt, hasWebhook: Boolean(b.webhookUrl) })),
      lastScanAt: bots.reduce<number | null>((m, b) => (b.lastScanAt && (!m || b.lastScanAt > m) ? b.lastScanAt : m), null),
      needs: items.filter((i) => i.section === "needs"),
      catchup: items.filter((i) => i.section === "catchup"),
      todos: await todosState(),
      agenda: store.listEvents(day, addDays(day, 2)),
    };
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

  async function act(item: Item, b: Record<string, unknown>) {
    const type = text(b.type, "type", 20, true);
    const outward = (fields: { type: "choose" | "send" | "write"; label: string; instruction?: string; text?: string }) => {
      if (Number(b.rev) !== item.rev) {
        throw conflict("This card changed since you opened it. Check it again before answering.");
      }
      // A read catch-up summary can still take a follow-up question.
      if (item.status === "closed" && !(item.section === "catchup" && fields.type === "write")) throw conflict("This card is already closed.");
      if (item.status === "snoozed") throw conflict("This card is snoozed. Restore it first.");
      if (store.pendingActionFor(item.id)) throw conflict("The bot is already working on this card.");
      return store.addAction({ item, bot: item.bot, delayMs: undoMs, ...fields });
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
        return { item: store.closeItem(item.id, "done", "Marked done") };
      case "dismiss":
        freeFromBot(item);
        return { item: store.closeItem(item.id, "dismissed", "Dismissed") };
      case "read":
        if (item.section !== "catchup") throw bad("Only catch-up summaries can be marked as read.");
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

  // Todoist calls for the same task run one after another, so a fast Undo can't overtake its completion.
  // closedHere remembers what this dashboard closed, so a double tap doesn't send two closes.
  const todoLocks = new Map<string, Promise<unknown>>();
  const closedHere = new Set<string>();
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = todoLocks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    todoLocks.set(key, next);
    void next.finally(() => { if (todoLocks.get(key) === next) todoLocks.delete(key); }).catch(() => {});
    return next;
  }

  async function completeTodo(bot: string, id: string, undo: boolean) {
    if (todoist && bot === "todoist") {
      await serial(id, async () => {
        if (undo) {
          if (!closedHere.has(id)) throw conflict("This to-do isn't completed from here.");
          await todoist.reopen(id);
          closedHere.delete(id);
        } else {
          if (closedHere.has(id)) throw conflict("This to-do is already completed.");
          await todoist.close(id);
          closedHere.add(id);
        }
      });
      return { ok: true };
    }
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
    const action = store.addAction({ todoId: id, todoDue: todo.due, bot, type: "complete_todo", label: todo.content, delayMs: undoMs });
    return { ok: true, action };
  }

  function actionForBot(a: Action) {
    return {
      id: a.id,
      type: a.type,
      label: a.label,
      instruction: a.instruction,
      text: a.text,
      todoId: a.todoId,
      // The card exactly as the user saw it when they tapped.
      card: a.itemId ? a.snapshot : null,
    };
  }

  function botHelp() {
    return {
      now: localStamp(new Date(store.now()), tz),
      timeZone: tz,
      today: today(),
      undoSeconds: config.undoSeconds,
      cards: {
        post: "POST /api/bot/items with one card or {\"items\": [...]} (up to 50). Same bot + key updates the card.",
        fields: {
          key: "stable id of the decision, like wa:<chat id>:<message id>. Up to 200 chars.",
          kind: "choice | draft | reminder (section needs), digest (section catchup)",
          title: "required, up to 200 chars, what's needed",
          body: "up to 2000 chars", context: "up to 1000 chars", source: "label like 'WhatsApp · Lab group', up to 120 chars",
          app: "whatsapp, gmail, googlecalendar, mail, github, todoist, subito, vinted, telegram... (shows the logo)",
          link: "http(s) link to the original", urgent: "deadline words like 'answer by 14:00', up to 60 chars",
          options: "choice only: 1 to 4 of {label (up to 60 chars), instruction (up to 1000)}. The instruction must do exactly what the label says.",
          draft: "draft only: {to, channel, text}", countLabel: "digest only, like '46 messages'",
          reopen: "true to bring back a card the user closed",
        },
        example: { key: "wa:120363@g.us:poll-7", kind: "choice", app: "whatsapp", source: "WhatsApp · Lab group", title: "Marco needs your vote on the lab swap", urgent: "answer by 14:00", options: [{ label: "Vote Tuesday", instruction: "Vote Tuesday in the Lab group poll" }] },
        list: "GET /api/bot/items?status=open|closed|all", close: "POST /api/bot/items/close {key, reason}",
      },
      actions: {
        take: "GET /api/bot/actions claims every waiting action. Do each one once, using its id to avoid doing it twice.",
        report: "POST /api/bot/actions/<id> {ok: true|false, result: 'one line'}. Report every action you took.",
        types: { choose: "do instruction (or label)", send: "send text exactly to card.draft.to on card.draft.channel", write: "text is the user's instruction about the card", complete_todo: "complete to-do todoId" },
      },
      agenda: "PUT /api/bot/agenda {from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' (default from + 2 days), app, events: [{title, start, end, location, allDay}]}. It REPLACES all your events overlapping from..to, so always send the complete list for that window.",
      todos: "PUT /api/bot/todos {app, todos: [{id, content, priority: 'p1'..'p4', due, dueString, deadline, project, url}]}. It REPLACES your whole list. Ignored when the dashboard reads Todoist directly.",
      scan: "POST /api/bot/scan {startedAt: 'YYYY-MM-DDTHH:MM:SS'} after a full scan where every source was read, with the time the scan began (the 'now' from grokdash actions). GET /api/bot/actions returns lastScanAt: scan for messages since then.",
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
    const parsed = list.map((x, i) => parseItem(x && typeof x === "object" && !Array.isArray(x) ? { bot: b.bot, ...x } : x, batch ? i : 0));
    const keys = parsed.map((p) => p.key).filter(Boolean);
    if (new Set(keys).size !== keys.length) throw bad("Two items in this call share a key. Send each key once.");
    const results = parsed.map((p) => {
      const r = store.upsertItem(p);
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
      if (!(start < to && (end || start) >= from)) {
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
    return { from, to, stored: events.length };
  });

  route("PUT", "/api/bot/todos", "bot", (_r, _p, _q, b) => {
    const bot = slug(b.bot);
    if (!Array.isArray(b.todos) || b.todos.length > 500) throw bad(`"todos" must be a list of up to 500 to-dos`);
    const todos = (b.todos as unknown[]).map((raw, i) => {
      const t = obj(raw, `todos[${i}]`);
      const priority = Number(String(t.priority ?? "p4").toLowerCase().replace(/^p/, ""));
      if (![1, 2, 3, 4].includes(priority)) throw bad(`todos[${i}].priority must be p1, p2, p3 or p4`);
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
      };
    });
    if (new Set(todos.map((t) => t.id)).size !== todos.length) throw bad("Two to-dos share an id. Send each id once.");
    store.replaceTodos(bot, todos);
    return { stored: todos.length, ignored: Boolean(todoist) };
  });

  route("GET", "/api/bot/actions", "bot", (_r, _p, q) => {
    const bot = slug(q.get("bot"));
    store.touchBot(bot);
    store.expireClaims(STALE_CLAIM_MS);
    store.promoteDue(bot);
    const actions = store.claimActions(bot).map(actionForBot);
    const b = store.getBot(bot)!;
    return {
      actions,
      refreshRequested: Boolean(b.refreshRequestedAt),
      lastScanAt: b.lastScanAt ? localStamp(new Date(b.lastScanAt), tz) : null,
      now: localStamp(new Date(store.now()), tz),
      timeZone: tz,
    };
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
    store.markScan(slug(b.bot), started ? zonedToEpoch(started.length === 10 ? started + "T00:00:00" : started, tz) : undefined);
    return { ok: true };
  });

  // UI API

  route("GET", "/api/ui/state", "ui", () => state());

  route("GET", "/api/ui/archive", "ui", (_r, _p, q) => {
    const offset = Math.max(0, Math.min(10_000, Math.floor(Number(q.get("offset") ?? 0)) || 0));
    const bot = q.get("bot");
    return store.archive(text(q.get("q"), "q", 100), config.archiveDays, 50, offset, bot && bot !== "all" ? slug(bot) : "");
  });

  route("POST", "/api/ui/items/:id/act", "ui", async (_r, p, _q, b) => {
    const res = await act(itemOr404(p[0]), b);
    return { ...res, state: await state() };
  });

  route("POST", "/api/ui/items/:id/ack", "ui", async (_r, p) => {
    store.ackItem(itemOr404(p[0]).id);
    return { ok: true, state: await state() };
  });

  route("POST", "/api/ui/actions/:id/undo", "ui", async (_r, p) => {
    if (!store.cancelAction(Number(p[0]))) throw conflict("Too late to undo: the bot already has it.");
    return { ok: true, state: await state() };
  });

  route("POST", "/api/ui/todos/complete", "ui", async (_r, _p, _q, b) => {
    const res = await completeTodo(text(b.bot, "bot", 40, true), text(String(b.id ?? ""), "id", 100, true), b.undo === true);
    return { ...res, state: await state() };
  });

  route("POST", "/api/ui/refresh", "ui", async () => {
    const bots = store.requestRefresh();
    for (const bot of bots) if (bot.webhookUrl) notify(bot.slug, "refresh");
    return { ok: true, webhooks: bots.filter((x) => x.webhookUrl).length, state: await state() };
  });

  // ----- auth -----

  function isOwner(req: http.IncomingMessage) {
    if (config.authMode === "none") return true;
    const login = String(req.headers["tailscale-user-login"] ?? "").toLowerCase();
    return login === config.ownerLogin;
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
      const scope = pathname.startsWith("/api/bot/") ? "bot" : "ui";
      if (scope === "bot" && !isBot(req)) throw new HttpError(401, "Missing or wrong bot token (Authorization: Bearer <BOT_TOKEN>).");
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
        if (scope === "bot" && typeof headerBot === "string") {
          if (body.bot === undefined) body.bot = headerBot;
          if (!u.searchParams.has("bot")) u.searchParams.set("bot", headerBot);
        }
        return send(res, 200, await r.fn(req, m.slice(1), u.searchParams, body));
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
