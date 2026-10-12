import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "./config.ts";
import type { Store, Item, ItemInput, Kind, Section, Option, Draft } from "./store.ts";
import { Todoist, pickTodos, addDays } from "./todoist.ts";

// Errors with a status code become JSON error responses; anything else is a 500.
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const bad = (msg: string) => new HttpError(400, msg);

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

function slug(v: unknown): string {
  const s = text(v, "bot", 32, true).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) throw bad(`"bot" must be a short id like "dashboard" (letters, digits, dashes)`);
  return s;
}

function url(v: unknown, field: string): string {
  const s = text(v, field, 2000);
  if (s && !/^https?:\/\//i.test(s)) throw bad(`"${field}" must start with http:// or https://`);
  return s;
}

const KINDS: Kind[] = ["choice", "draft", "reminder", "digest"];

export function parseItem(b: Record<string, unknown>): ItemInput {
  const section: Section = b.section === "catchup" || b.kind === "digest" ? "catchup" : "needs";
  const kind = (b.kind ?? (section === "catchup" ? "digest" : "reminder")) as Kind;
  if (!KINDS.includes(kind)) throw bad(`"kind" must be one of ${KINDS.join(", ")}`);
  if (section === "needs" && kind === "digest") throw bad(`kind "digest" belongs in section "catchup"`);
  let options: Option[] = [];
  if (b.options != null) {
    if (!Array.isArray(b.options) || b.options.length > 4) throw bad(`"options" must be a list of up to 4 answers`);
    options = b.options.map((o, i) => {
      const obj = (typeof o === "string" ? { label: o } : o) as Record<string, unknown>;
      return { label: text(obj?.label, `options[${i}].label`, 60, true), instruction: text(obj?.instruction, `options[${i}].instruction`, 1000) };
    });
  }
  if (kind === "choice" && options.length < 1) throw bad(`a "choice" needs at least one entry in "options"`);
  let draft: Draft | null = null;
  if (kind === "draft") {
    const d = b.draft as Record<string, unknown> | undefined;
    if (!d || typeof d !== "object") throw bad(`a "draft" needs "draft": { "to", "text" }`);
    draft = { to: text(d.to, "draft.to", 80, true), channel: text(d.channel, "draft.channel", 40), text: text(d.text, "draft.text", 4000, true) };
  }
  return {
    bot: slug(b.bot),
    key: text(b.key, "key", 200) || null,
    section,
    kind,
    title: text(b.title, "title", 200, true),
    body: text(b.body, "body", 2000),
    context: text(b.context, "context", 1000),
    source: text(b.source, "source", 120),
    link: url(b.link, "link"),
    urgent: text(b.urgent, "urgent", 60),
    countLabel: text(b.countLabel, "countLabel", 40),
    options,
    draft,
    reopen: b.reopen === true,
  };
}

// ---------- Time helpers (server time zone, TZ env) ----------

export function localStamp(d: Date, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Store times as local wall-clock "YYYY-MM-DDTHH:MM:SS" so the page never has to guess time zones. */
function normalizeWhen(v: unknown, field: string, tz: string, required: boolean): string {
  const s = text(v, field, 40, required);
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return s.length === 16 ? s + ":00" : s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw bad(`"${field}" must be a date like 2026-10-12 or 2026-10-12T14:30:00+02:00`);
  return localStamp(d, tz);
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

// ---------- The app ----------

export interface AppDeps {
  config: Config;
  store: Store;
  todoist?: Todoist | null;
  notify?: (bot: string, reason: "actions" | "refresh") => void;
  tz?: string;
  log?: (msg: string) => void;
}

const RECENT_MS = 10 * 60_000;
const STALE_CLAIM_MS = 20 * 60_000;

export function createApp(deps: AppDeps) {
  const { config, store } = deps;
  const todoist = deps.todoist ?? null;
  const tz = deps.tz ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const notify = deps.notify ?? (() => {});
  const log = deps.log ?? ((m: string) => console.log(m));
  const undoMs = config.undoSeconds * 1000;
  const today = () => localStamp(new Date(store.now()), tz).slice(0, 10);

  function uiItem(i: Item) {
    const a = i.status === "pending" ? store.pendingActionFor(i.id) : null;
    return {
      ...i,
      pendingAction: a ? { id: a.id, type: a.type, label: a.label, text: a.text, status: a.status, runAfter: a.runAfter } : null,
    };
  }

  async function todosState() {
    if (todoist) {
      try {
        const all = await todoist.list();
        const { todos, hidden } = pickTodos(all, today());
        return { source: "todoist", items: todos, hidden, error: "" };
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
    const items = store.activeItems(RECENT_MS).map(uiItem);
    const day = today();
    const bots = store.listBots();
    return {
      now: store.now(),
      today: day,
      tz,
      undoSeconds: config.undoSeconds,
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
    if (!item) throw new HttpError(404, "No item with that id. It may have been archived.");
    return item;
  }

  async function act(item: Item, b: Record<string, unknown>) {
    const type = text(b.type, "type", 20, true);
    const outward = (fields: { type: "choose" | "send" | "write"; label: string; instruction?: string; text?: string }) => {
      if (item.status === "closed") throw new HttpError(409, "This card is already closed.");
      if (store.pendingActionFor(item.id)) throw new HttpError(409, "The bot is already working on this card.");
      return store.addAction({ itemId: item.id, bot: item.bot, delayMs: undoMs, ...fields });
    };
    switch (type) {
      case "choose": {
        const n = Number(b.option);
        const opt = item.options[n];
        if (!opt) throw bad("Unknown option.");
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
        return { item: store.closeItem(item.id, "done", "Marked done") };
      case "dismiss":
        return { item: store.closeItem(item.id, "dismissed", "Dismissed") };
      case "read":
        return { item: store.closeItem(item.id, "read", "Read") };
      case "snooze": {
        const until = typeof b.until === "number" ? b.until : Date.parse(String(b.until));
        if (!Number.isFinite(until) || until <= store.now()) throw bad(`"until" must be a time in the future`);
        return { item: store.snoozeItem(item.id, until) };
      }
      case "restore":
        return { item: store.reopenItem(item.id) };
      default:
        throw bad(`Unknown action "${type}".`);
    }
  }

  async function completeTodo(id: string, undo: boolean) {
    if (todoist) {
      if (undo) await todoist.reopen(id);
      else await todoist.close(id);
      return { ok: true };
    }
    const todo = store.findTodo(id);
    if (!todo) throw new HttpError(404, "No to-do with that id.");
    if (undo) {
      const pending = store.db
        .prepare("SELECT id FROM actions WHERE todo_id = ? AND type = 'complete_todo' AND status = 'queued' ORDER BY id DESC LIMIT 1")
        .get(id) as { id: number } | undefined;
      if (pending) store.cancelAction(Number(pending.id));
      store.setTodoCompleted(todo.bot, id, false);
      return { ok: true };
    }
    store.setTodoCompleted(todo.bot, id, true);
    const action = store.addAction({ todoId: id, bot: todo.bot, type: "complete_todo", label: todo.content, delayMs: undoMs });
    return { ok: true, action };
  }

  // ----- routing -----

  type Handler = (req: http.IncomingMessage, params: string[], query: URLSearchParams, body: Record<string, unknown>) => unknown;
  const routes: { method: string; re: RegExp; scope: "bot" | "ui"; fn: Handler }[] = [];
  const route = (method: string, pattern: string, scope: "bot" | "ui", fn: Handler) =>
    routes.push({ method, re: new RegExp("^" + pattern.replace(/:\w+/g, "([^/]+)") + "$"), scope, fn });

  // Bot API

  route("GET", "/api/bot/help", "bot", () => ({ docs: "See docs/API.md in the repo. Every call needs a \"bot\" id like \"dashboard\"." }));

  route("POST", "/api/bot/register", "bot", (_r, _p, _q, b) => {
    const bot = store.updateBot(slug(b.bot), {
      name: b.name === undefined ? undefined : text(b.name, "name", 40, true),
      color: b.color === undefined ? undefined : text(b.color, "color", 20),
      webhookUrl: b.webhookUrl === undefined ? undefined : url(b.webhookUrl, "webhookUrl"),
      webhookToken: b.webhookToken === undefined ? undefined : text(b.webhookToken, "webhookToken", 500),
    });
    // Never echo secrets back.
    return { bot: { slug: bot.slug, name: bot.name, color: bot.color, webhookUrl: bot.webhookUrl ? "set" : "", webhookToken: bot.webhookToken ? "set" : "" } };
  });

  route("POST", "/api/bot/items", "bot", (_r, _p, _q, b) => {
    const list = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [b];
    if (list.length > 50) throw bad("Send at most 50 items per call.");
    const parsed = list.map((x) => parseItem({ bot: b.bot, ...x }));
    const results = parsed.map((p) => {
      const r = store.upsertItem(p);
      return { id: r.item.id, key: r.item.key, status: r.item.status, created: r.created, reopened: r.reopened, ignored: r.ignored };
    });
    return Array.isArray(b.items) ? { results } : results[0];
  });

  route("GET", "/api/bot/items", "bot", (_r, _p, q) => {
    const status = (q.get("status") ?? "open") as "open" | "closed" | "all";
    const section = q.get("section") as Section | null;
    return {
      items: store.listItems({ bot: q.get("bot") ? slug(q.get("bot")) : undefined, section: section ?? undefined, status }).map((i) => ({
        id: i.id, key: i.key, section: i.section, kind: i.kind, title: i.title, status: i.status, closedReason: i.closedReason, resolution: i.resolution, updatedAt: i.updatedAt,
      })),
    };
  });

  route("POST", "/api/bot/items/close", "bot", (_r, _p, _q, b) => {
    const bot = slug(b.bot);
    const item = b.id != null ? store.getItem(Number(b.id)) : store.getItemByKey(bot, text(b.key, "key", 200, true));
    if (!item || item.bot !== bot) throw new HttpError(404, "No item with that id or key for this bot.");
    const closed = store.closeItem(item.id, "bot", text(b.reason, "reason", 200) || "Closed by the bot");
    return { id: closed!.id, status: closed!.status };
  });

  route("PUT", "/api/bot/agenda", "bot", (_r, _p, _q, b) => {
    const bot = slug(b.bot);
    if (!Array.isArray(b.events) || b.events.length > 200) throw bad(`"events" must be a list of up to 200 events`);
    const from = b.from ? normalizeWhen(b.from, "from", tz, true).slice(0, 10) : today();
    const to = b.to ? normalizeWhen(b.to, "to", tz, true).slice(0, 10) : addDays(from, 2);
    const events = (b.events as Record<string, unknown>[]).map((e, i) => {
      const start = normalizeWhen(e.start, `events[${i}].start`, tz, true);
      return {
        title: text(e.title, `events[${i}].title`, 200, true),
        start,
        end: normalizeWhen(e.end, `events[${i}].end`, tz, false),
        location: text(e.location, `events[${i}].location`, 200),
        allDay: e.allDay === true || start.length === 10,
      };
    });
    store.replaceEvents(bot, from, to, events);
    return { from, to, stored: events.length };
  });

  route("PUT", "/api/bot/todos", "bot", (_r, _p, _q, b) => {
    const bot = slug(b.bot);
    if (!Array.isArray(b.todos) || b.todos.length > 500) throw bad(`"todos" must be a list of up to 500 to-dos`);
    const todos = (b.todos as Record<string, unknown>[]).map((t, i) => {
      const p = String(t.priority ?? "p4").toLowerCase().replace(/^p/, "");
      const priority = Number(p);
      if (![1, 2, 3, 4].includes(priority)) throw bad(`todos[${i}].priority must be p1, p2, p3 or p4`);
      return {
        id: text(t.id, `todos[${i}].id`, 100, true),
        content: text(t.content, `todos[${i}].content`, 300, true),
        priority,
        due: normalizeWhen(t.due, `todos[${i}].due`, tz, false),
        dueString: text(t.dueString, `todos[${i}].dueString`, 80),
        deadline: normalizeWhen(t.deadline, `todos[${i}].deadline`, tz, false).slice(0, 10),
        project: text(t.project, `todos[${i}].project`, 80),
        url: url(t.url, `todos[${i}].url`),
      };
    });
    store.replaceTodos(bot, todos);
    return { stored: todos.length };
  });

  route("GET", "/api/bot/actions", "bot", (_r, _p, q) => {
    const bot = slug(q.get("bot"));
    store.touchBot(bot);
    store.promoteDue();
    const actions = store.claimActions(bot, STALE_CLAIM_MS).map((a) => {
      const item = a.itemId ? store.getItem(a.itemId) : null;
      return {
        id: a.id,
        type: a.type,
        label: a.label,
        instruction: a.instruction,
        text: a.text,
        todoId: a.todoId,
        item: item ? { id: item.id, key: item.key, title: item.title, source: item.source, link: item.link, draft: item.draft } : null,
      };
    });
    const b = store.getBot(bot)!;
    return { actions, refreshRequested: Boolean(b.refreshRequestedAt) };
  });

  route("POST", "/api/bot/actions/:id", "bot", (_r, p, _q, b) => {
    if (typeof b.ok !== "boolean") throw bad(`"ok" must be true or false`);
    const a = store.finishAction(Number(p[0]), b.ok, text(b.result, "result", 500));
    if (!a) throw new HttpError(404, "No action with that id.");
    return { id: a.id, status: a.status };
  });

  route("POST", "/api/bot/scan", "bot", (_r, _p, _q, b) => {
    store.markScan(slug(b.bot));
    return { ok: true };
  });

  // UI API

  route("GET", "/api/ui/state", "ui", () => state());

  route("GET", "/api/ui/archive", "ui", (_r, _p, q) => ({
    items: store.archive(text(q.get("q"), "q", 100), config.archiveDays),
  }));

  route("POST", "/api/ui/items/:id/act", "ui", async (_r, p, _q, b) => {
    const res = await act(itemOr404(p[0]), b);
    return { ...res, state: await state() };
  });

  route("POST", "/api/ui/items/:id/ack", "ui", async (_r, p) => {
    store.ackItem(itemOr404(p[0]).id);
    return { ok: true };
  });

  route("POST", "/api/ui/actions/:id/undo", "ui", async (_r, p) => {
    const a = store.cancelAction(Number(p[0]));
    if (!a) throw new HttpError(409, "Too late to undo: the bot already has it.");
    if (a.todoId) store.setTodoCompleted(a.bot, a.todoId, false);
    return { ok: true, state: await state() };
  });

  route("POST", "/api/ui/todos/:id/complete", "ui", async (_r, p, _q, b) => {
    const res = await completeTodo(decodeURIComponent(p[0]), b.undo === true);
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

  function send(res: http.ServerResponse, status: number, body: unknown) {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
    res.end(json);
  }

  function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 512 * 1024) {
          reject(new HttpError(413, "Body too large (max 512 KB)."));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
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
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const file = path.resolve(config.publicDir, rel);
    if (!file.startsWith(config.publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
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
    const u = new URL(req.url ?? "/", "http://local");
    try {
      if (u.pathname === "/healthz") return send(res, 200, { ok: true });
      const isApi = u.pathname.startsWith("/api/");
      const scope = u.pathname.startsWith("/api/bot/") ? "bot" : "ui";
      if (scope === "bot" && !isBot(req)) throw new HttpError(401, "Missing or wrong bot token (Authorization: Bearer <BOT_TOKEN>).");
      if (scope === "ui" && !isOwner(req)) {
        throw new HttpError(403, "This dashboard only opens for its owner's Tailscale account.");
      }
      if (!isApi) {
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
        return serveStatic(req, res, u.pathname);
      }
      // Requiring JSON on writes blocks cross-site form posts: browsers can't send it without a CORS preflight we never answer.
      if (req.method !== "GET" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        throw new HttpError(415, "Send JSON with Content-Type: application/json.");
      }
      for (const r of routes) {
        if (r.method !== req.method || r.scope !== scope) continue;
        const m = r.re.exec(u.pathname);
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
      throw new HttpError(404, `No route for ${req.method} ${u.pathname}.`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`error on ${req.method} ${u.pathname}: ${(err as Error).stack}`);
      if (status === 403 && !u.pathname.startsWith("/api/")) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
        return res.end("This dashboard only opens for its owner's Tailscale account.");
      }
      return send(res, status, { error: status === 500 ? "Something broke on the server. Check its logs." : (err as Error).message });
    }
  };
}
