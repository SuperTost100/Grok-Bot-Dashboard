import { DatabaseSync, backup } from "node:sqlite";

// Everything the dashboard remembers lives in one SQLite file.
// Times are Unix milliseconds.

export type Section = "needs" | "catchup";
export type Kind = "choice" | "draft" | "reminder" | "digest";
export type ItemStatus = "open" | "pending" | "snoozed" | "closed";
/**
 * queued: inside the undo window. ready: waiting for the bot. claimed: the bot took it.
 * unknown: the bot took it but never reported back, so nobody knows if it happened.
 */
export type ActionStatus = "queued" | "ready" | "claimed" | "unknown" | "done" | "failed" | "cancelled";
export type ActionType = "choose" | "send" | "write" | "complete_todo";

export interface Option { label: string; instruction?: string }
export interface Draft { to: string; channel?: string; text: string }

export interface Item {
  id: number;
  bot: string;
  key: string | null;
  section: Section;
  kind: Kind;
  title: string;
  body: string;
  context: string;
  source: string;
  app: string;
  link: string;
  urgent: string;
  countLabel: string;
  options: Option[];
  draft: Draft | null;
  status: ItemStatus;
  /** Goes up whenever the card's content changes, so a tap always matches the card that was on screen. */
  rev: number;
  snoozedUntil: number | null;
  closedReason: string;
  resolution: string;
  error: string;
  createdAt: number;
  /** Last time the content changed. Reposting the same card doesn't move it. */
  updatedAt: number;
  closedAt: number | null;
  ackedAt: number | null;
}

/** What the user approved, frozen at tap time. The bot acts on this, never on a newer version of the card. */
export interface Snapshot {
  id: number;
  key: string | null;
  rev: number;
  title: string;
  body: string;
  context: string;
  source: string;
  app: string;
  link: string;
  draft: Draft | null;
  /** The card's status before the tap, to put back on Undo (a read summary stays read). */
  status?: ItemStatus;
  /** For to-do completions: which occurrence was completed. */
  todoDue?: string;
}

export interface Action {
  id: number;
  itemId: number | null;
  todoId: string | null;
  bot: string;
  type: ActionType;
  label: string;
  instruction: string;
  text: string;
  snapshot: Snapshot | null;
  status: ActionStatus;
  runAfter: number;
  createdAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
  result: string;
}

export interface Bot {
  slug: string;
  name: string;
  color: string;
  webhookUrl: string;
  webhookToken: string;
  lastSeenAt: number | null;
  lastScanAt: number | null;
  refreshRequestedAt: number | null;
  /** Daily scheduled run times ("HH:MM"), so the page can tell when a run never showed up. */
  schedule: string[];
}

export interface CalEvent {
  id: number;
  bot: string;
  title: string;
  start: string;
  end: string;
  location: string;
  allDay: boolean;
  app: string;
}

export interface BotTodo {
  id: string;
  bot: string;
  content: string;
  priority: number;
  due: string;
  dueString: string;
  deadline: string;
  project: string;
  url: string;
  app: string;
  completedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bots (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  webhook_url TEXT NOT NULL DEFAULT '',
  webhook_token TEXT NOT NULL DEFAULT '',
  last_seen_at INTEGER,
  last_scan_at INTEGER,
  refresh_requested_at INTEGER
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot TEXT NOT NULL,
  key TEXT,
  section TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  app TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  urgent TEXT NOT NULL DEFAULT '',
  count_label TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  draft TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  rev INTEGER NOT NULL DEFAULT 1,
  snoozed_until INTEGER,
  closed_reason TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  acked_at INTEGER,
  UNIQUE (bot, key)
);
CREATE INDEX IF NOT EXISTS items_status ON items (status, section);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER REFERENCES items (id) ON DELETE CASCADE,
  todo_id TEXT,
  bot TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  snapshot TEXT,
  status TEXT NOT NULL,
  run_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  finished_at INTEGER,
  result TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS actions_status ON actions (status, bot);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot TEXT NOT NULL,
  title TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  all_day INTEGER NOT NULL DEFAULT 0,
  app TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS todos (
  id TEXT NOT NULL,
  bot TEXT NOT NULL,
  content TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 4,
  due TEXT NOT NULL DEFAULT '',
  due_string TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  app TEXT NOT NULL DEFAULT '',
  completed_at INTEGER,
  completed_due TEXT,
  PRIMARY KEY (bot, id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  thread_name TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  from_me INTEGER NOT NULL DEFAULT 0,
  is_group INTEGER NOT NULL DEFAULT 0,
  automated INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  triaged_at INTEGER,
  UNIQUE (source, ext_id)
);
CREATE INDEX IF NOT EXISTS inbox_untriaged ON inbox (triaged_at, source, thread);
CREATE INDEX IF NOT EXISTS inbox_thread ON inbox (source, thread, at);
CREATE TABLE IF NOT EXISTS triage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  thread TEXT NOT NULL,
  message_ids TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}',
  level INTEGER NOT NULL,
  need TEXT NOT NULL,
  route TEXT NOT NULL,
  item_id INTEGER,
  grok TEXT,
  grok_at INTEGER,
  queued_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  card_key TEXT,
  cost REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS triage_grok ON triage (grok, level);
CREATE TABLE IF NOT EXISTS wakes (
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  bot TEXT NOT NULL DEFAULT ''
);
`;

// Columns added after the first release, as [table, column, definition].
const MIGRATIONS: [string, string, string][] = [
  ["bots", "webhook_token", "TEXT NOT NULL DEFAULT ''"],
  ["items", "app", "TEXT NOT NULL DEFAULT ''"],
  ["items", "rev", "INTEGER NOT NULL DEFAULT 1"],
  ["events", "app", "TEXT NOT NULL DEFAULT ''"],
  ["todos", "app", "TEXT NOT NULL DEFAULT ''"],
  ["todos", "completed_due", "TEXT"],
  ["actions", "snapshot", "TEXT"],
  ["bots", "schedule", "TEXT NOT NULL DEFAULT ''"],
  ["triage", "queued_at", "INTEGER"],
  ["triage", "attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["wakes", "bot", "TEXT NOT NULL DEFAULT ''"],
  ["triage", "card_key", "TEXT"],
];

// An event overlaps [from, to) when it starts before `to` and is still going at `from`.
// A datetime end is exclusive (ending at 00:00 doesn't touch that day); a date-only end includes that day.
const OVERLAP = "start < ? AND ((end = '' AND start >= ?) OR (length(end) = 10 AND end >= ?) OR (length(end) > 10 AND end > ?))";

// Colors for bots that don't pick one. Muted enough to sit next to the ink UI.
const PALETTE = ["#c2412d", "#2f7d5b", "#3b6fb6", "#8a5cc2", "#b7791f", "#2b8a8a", "#a23b72", "#5b5a55"];

type Row = Record<string, unknown>;

const str = (v: unknown) => (v == null ? "" : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

function toItem(r: Row): Item {
  return {
    id: Number(r.id),
    bot: str(r.bot),
    key: r.key == null ? null : String(r.key),
    section: r.section as Section,
    kind: r.kind as Kind,
    title: str(r.title),
    body: str(r.body),
    context: str(r.context),
    source: str(r.source),
    app: str(r.app),
    link: str(r.link),
    urgent: str(r.urgent),
    countLabel: str(r.count_label),
    options: JSON.parse(str(r.options) || "[]"),
    draft: r.draft ? JSON.parse(str(r.draft)) : null,
    status: r.status as ItemStatus,
    rev: Number(r.rev ?? 1),
    snoozedUntil: num(r.snoozed_until),
    closedReason: str(r.closed_reason),
    resolution: str(r.resolution),
    error: str(r.error),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    closedAt: num(r.closed_at),
    ackedAt: num(r.acked_at),
  };
}

function toAction(r: Row): Action {
  return {
    id: Number(r.id),
    itemId: num(r.item_id),
    todoId: r.todo_id == null ? null : String(r.todo_id),
    bot: str(r.bot),
    type: r.type as ActionType,
    label: str(r.label),
    instruction: str(r.instruction),
    text: str(r.text),
    snapshot: r.snapshot ? JSON.parse(str(r.snapshot)) : null,
    status: r.status as ActionStatus,
    runAfter: Number(r.run_after),
    createdAt: Number(r.created_at),
    claimedAt: num(r.claimed_at),
    finishedAt: num(r.finished_at),
    result: str(r.result),
  };
}

function toBot(r: Row): Bot {
  return {
    slug: str(r.slug),
    name: str(r.name),
    color: str(r.color),
    webhookUrl: str(r.webhook_url),
    webhookToken: str(r.webhook_token),
    lastSeenAt: num(r.last_seen_at),
    lastScanAt: num(r.last_scan_at),
    refreshRequestedAt: num(r.refresh_requested_at),
    schedule: str(r.schedule).split(" ").filter(Boolean),
  };
}

function toTodo(row: Row): BotTodo {
  return {
    id: str(row.id),
    bot: str(row.bot),
    content: str(row.content),
    priority: Number(row.priority),
    due: str(row.due),
    dueString: str(row.due_string),
    deadline: str(row.deadline),
    project: str(row.project),
    url: str(row.url),
    app: str(row.app),
    completedAt: num(row.completed_at),
  };
}

/** A message the dashboard read itself, waiting for triage. */
export interface InboxMessage {
  id: number;
  /** "whatsapp", or "mail:<slot>" like "mail:1". */
  source: string;
  extId: string;
  /** Chat id, or the mail thread's first Message-ID. */
  thread: string;
  threadName: string;
  sender: string;
  fromMe: boolean;
  isGroup: boolean;
  /** Headers or the chat type say a machine sent it (newsletter, notification). A hint, not a verdict. */
  automated: boolean;
  subject: string;
  text: string;
  link: string;
  at: number;
  receivedAt: number;
  triagedAt: number | null;
}

export type InboxInput = Omit<InboxMessage, "id" | "receivedAt" | "triagedAt">;

function toInbox(r: Row): InboxMessage {
  return {
    id: Number(r.id),
    source: str(r.source),
    extId: str(r.ext_id),
    thread: str(r.thread),
    threadName: str(r.thread_name),
    sender: str(r.sender),
    fromMe: Number(r.from_me) === 1,
    isGroup: Number(r.is_group) === 1,
    automated: Number(r.automated) === 1,
    subject: str(r.subject),
    text: str(r.text),
    link: str(r.link),
    at: Number(r.at),
    receivedAt: Number(r.received_at),
    triagedAt: num(r.triaged_at),
  };
}

export interface ItemInput {
  bot: string;
  key?: string | null;
  section: Section;
  kind: Kind;
  title: string;
  body?: string;
  context?: string;
  source?: string;
  app?: string;
  link?: string;
  urgent?: string;
  countLabel?: string;
  options?: Option[];
  draft?: Draft | null;
  reopen?: boolean;
}

/**
 * One triage decision about the new messages of a chat or mail thread.
 * route: wake (Grok now), ride (Grok at its next wake), card (a card without Grok), catchup, skip.
 * grok: null when Grok isn't needed (or a later decision about the same chat replaced this one),
 * queued, sent once Grok took it, done when Grok wrote or closed the card, failed after two tries.
 */
export interface TriageRow {
  id: number;
  source: string;
  thread: string;
  messageIds: number[];
  decidedAt: number;
  answers: Record<string, unknown>;
  level: number;
  need: string;
  route: string;
  itemId: number | null;
  grok: "queued" | "sent" | "done" | "failed" | null;
  grokAt: number | null;
  /** When the chat started waiting for Grok. */
  queuedAt: number | null;
  /** How often it was handed to Grok. */
  attempts: number;
  /** The card Grok works on for this decision, when it isn't the chat's Needs-you card (a calendar addition). */
  cardKey: string | null;
  cost: number;
}

function toTriage(r: Row): TriageRow {
  return {
    id: Number(r.id),
    source: str(r.source),
    thread: str(r.thread),
    messageIds: JSON.parse(str(r.message_ids) || "[]"),
    decidedAt: Number(r.decided_at),
    answers: JSON.parse(str(r.answers) || "{}"),
    level: Number(r.level),
    need: str(r.need),
    route: str(r.route),
    itemId: num(r.item_id),
    grok: (r.grok as TriageRow["grok"]) ?? null,
    grokAt: num(r.grok_at),
    queuedAt: num(r.queued_at),
    attempts: Number(r.attempts ?? 0),
    cardKey: r.card_key == null ? null : String(r.card_key),
    cost: Number(r.cost ?? 0),
  };
}

export class Store {
  db: DatabaseSync;
  now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.db = new DatabaseSync(file);
    this.now = now;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
    for (const [table, column, def] of MIGRATIONS) {
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name));
      if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
    // Taps from before snapshots existed can't tell the bot what the user saw: drop the ones still waiting.
    this.db.exec(`UPDATE items SET status = 'open' WHERE status = 'pending' AND id IN
      (SELECT item_id FROM actions WHERE snapshot IS NULL AND item_id IS NOT NULL AND status IN ('queued', 'ready'))`);
    this.db.exec("UPDATE actions SET status = 'cancelled' WHERE snapshot IS NULL AND item_id IS NOT NULL AND status IN ('queued', 'ready')");
  }

  close() {
    this.db.close();
  }

  /** A consistent copy of the database, safe to take while the server runs. */
  async backupTo(file: string) {
    await backup(this.db, file);
  }

  /** Run fn in one transaction. Inside another transaction it simply joins that one. */
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // Settings saved on the Settings page, as JSON text

  getSetting(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  setSetting(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // Small values the server keeps between runs, like where each source stopped reading

  getState(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  setState(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM state WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // Inbox: messages read straight from WhatsApp and mail

  /**
   * Store new messages. A message already stored (same source and id) is skipped. Returns how many were new.
   * With `state`, a source's cursor is saved in the same transaction, so it never moves past messages that weren't stored.
   */
  addInbox(messages: InboxInput[], state?: { key: string; value: string }): number {
    return this.tx(() => {
      if (state) this.setState(state.key, state.value);
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO inbox (source, ext_id, thread, thread_name, sender, from_me, is_group, automated, subject, text, link, at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let added = 0;
      for (const m of messages) {
        const res = ins.run(
          m.source, m.extId, m.thread, m.threadName, m.sender, m.fromMe ? 1 : 0, m.isGroup ? 1 : 0, m.automated ? 1 : 0,
          m.subject, m.text, m.link, m.at, this.now(),
        );
        added += Number(res.changes);
      }
      return added;
    });
  }

  untriaged(limit = 500): InboxMessage[] {
    return this.db.prepare("SELECT * FROM inbox WHERE triaged_at IS NULL ORDER BY at, id LIMIT ?").all(limit).map((r) => toInbox(r as Row));
  }

  /** The latest messages of one chat or thread, oldest first, for context. */
  threadMessages(source: string, thread: string, limit = 20): InboxMessage[] {
    return this.db
      .prepare("SELECT * FROM (SELECT * FROM inbox WHERE source = ? AND thread = ? ORDER BY at DESC, id DESC LIMIT ?) ORDER BY at, id")
      .all(source, thread, limit)
      .map((r) => toInbox(r as Row));
  }

  markTriaged(ids: number[]) {
    const upd = this.db.prepare("UPDATE inbox SET triaged_at = ? WHERE id = ?");
    this.tx(() => { for (const id of ids) upd.run(this.now(), id); });
  }

  /** Message text is only needed while it's recent. */
  purgeInbox(days: number): number {
    return Number(this.db.prepare("DELETE FROM inbox WHERE at < ?").run(this.now() - days * 86_400_000).changes);
  }

  // Triage decisions and Grok wakes

  addTriage(t: Omit<TriageRow, "id" | "grokAt" | "attempts" | "queuedAt" | "cardKey"> & { queuedAt?: number | null; cardKey?: string | null }): TriageRow {
    const res = this.db
      .prepare(
        `INSERT INTO triage (source, thread, message_ids, decided_at, answers, level, need, route, item_id, grok, queued_at, card_key, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.source, t.thread, JSON.stringify(t.messageIds), t.decidedAt, JSON.stringify(t.answers), t.level, t.need, t.route,
        t.itemId, t.grok, t.grok === "queued" ? t.queuedAt ?? this.now() : null, t.cardKey ?? null, t.cost,
      );
    return this.getTriage(Number(res.lastInsertRowid))!;
  }

  getTriage(id: number): TriageRow | null {
    const r = this.db.prepare("SELECT * FROM triage WHERE id = ?").get(id);
    return r ? toTriage(r as Row) : null;
  }

  /** Decisions waiting for Grok, oldest first. There's at most one per chat. */
  grokQueue(): TriageRow[] {
    return this.db.prepare("SELECT * FROM triage WHERE grok = 'queued' ORDER BY queued_at, id").all().map((r) => toTriage(r as Row));
  }

  /** The decision still waiting for Grok about this chat, if any. */
  queuedFor(source: string, thread: string): TriageRow | null {
    const r = this.db.prepare("SELECT * FROM triage WHERE grok = 'queued' AND route != 'calendar' AND source = ? AND thread = ? ORDER BY id DESC LIMIT 1").get(source, thread);
    return r ? toTriage(r as Row) : null;
  }

  /**
   * The decision about this chat that Grok still owes: queued, or handed out and not confirmed.
   * Calendar additions aren't counted: they stand on their own, whatever the chat says next.
   */
  outstandingFor(source: string, thread: string): TriageRow | null {
    const r = this.db.prepare("SELECT * FROM triage WHERE grok IN ('queued', 'sent') AND route != 'calendar' AND source = ? AND thread = ? ORDER BY id DESC LIMIT 1").get(source, thread);
    return r ? toTriage(r as Row) : null;
  }

  /** Hand the queue to Grok. Grok confirms each chat by writing or closing its card (ackGrok). */
  claimGrokQueue(limit = 30): TriageRow[] {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT * FROM triage WHERE grok = 'queued' ORDER BY level DESC, queued_at, id LIMIT ?").all(limit).map((r) => toTriage(r as Row));
      const upd = this.db.prepare("UPDATE triage SET grok = 'sent', grok_at = ?, attempts = attempts + 1 WHERE id = ?");
      for (const t of rows) upd.run(this.now(), t.id);
      return rows.map((t) => ({ ...t, grok: "sent" as const, grokAt: this.now(), attempts: t.attempts + 1 }));
    });
  }

  /** Chats handed to Grok and not confirmed yet. */
  sentToGrok(): TriageRow[] {
    return this.db.prepare("SELECT * FROM triage WHERE grok = 'sent'").all().map((r) => toTriage(r as Row));
  }

  setGrok(id: number, grok: TriageRow["grok"]) {
    this.db.prepare("UPDATE triage SET grok = ? WHERE id = ?").run(grok, id);
  }

  /**
   * Chats Grok took but never confirmed go back to the queue, as new work, so they get one more wake.
   * After `maxAttempts` hand-outs they're marked failed; the card stays on the page for you.
   */
  expireGrokClaims(before: number, maxAttempts: number): { requeued: number; failed: number } {
    return this.tx(() => {
      const stale = this.db.prepare("SELECT * FROM triage WHERE grok = 'sent' AND grok_at < ?").all(before).map((r) => toTriage(r as Row));
      let requeued = 0;
      for (const t of stale) {
        // A newer decision about the chat is already queued: that one carries the messages.
        const newer = t.route === "calendar" ? null : this.queuedFor(t.source, t.thread);
        if (t.attempts >= maxAttempts || newer) {
          this.setGrok(t.id, newer ? null : "failed");
        } else {
          this.db.prepare("UPDATE triage SET grok = 'queued', queued_at = ? WHERE id = ?").run(this.now(), t.id);
          requeued++;
        }
      }
      return { requeued, failed: stale.length - requeued };
    });
  }

  /**
   * A chat no longer needs Grok (you replied yourself, or a newer decision takes its place):
   * whatever it still owed for the chat, queued or handed out, is dropped.
   */
  dropFromGrokQueue(source: string, thread: string) {
    this.db.prepare("UPDATE triage SET grok = NULL WHERE grok IN ('queued', 'sent') AND route != 'calendar' AND source = ? AND thread = ?").run(source, thread);
  }

  triageSince(since: number): TriageRow[] {
    return this.db.prepare("SELECT * FROM triage WHERE decided_at >= ? ORDER BY decided_at, id").all(since).map((r) => toTriage(r as Row));
  }

  inboxByIds(ids: number[]): InboxMessage[] {
    if (!ids.length) return [];
    return this.db
      .prepare(`SELECT * FROM inbox WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY at, id`)
      .all(...ids)
      .map((r) => toInbox(r as Row));
  }

  /** A bot run started by a webhook ping. */
  addWake(reason: string, bot: string) {
    this.db.prepare("INSERT INTO wakes (at, reason, bot) VALUES (?, ?, ?)").run(this.now(), reason, bot);
  }

  wakesSince(since: number, bot: string): { at: number; reason: string }[] {
    return (this.db.prepare("SELECT at, reason FROM wakes WHERE at >= ? AND bot = ? ORDER BY at").all(since, bot) as Row[]).map((r) => ({
      at: Number(r.at),
      reason: str(r.reason),
    }));
  }

  /** Open cards that triage made for a chat or thread. Their keys start with inbox:<source>:<thread>:. */
  triageCards(bot: string, source: string, thread: string): Item[] {
    const prefix = `inbox:${source}:${thread}:`;
    return this.db
      .prepare("SELECT * FROM items WHERE bot = ? AND status IN ('open', 'snoozed') AND substr(key, 1, ?) = ?")
      .all(bot, prefix.length, prefix)
      .map((r) => toItem(r as Row));
  }

  // Bots

  touchBot(slug: string): Bot {
    const now = this.now();
    const existing = this.db.prepare("SELECT * FROM bots WHERE slug = ?").get(slug);
    if (existing) {
      this.db.prepare("UPDATE bots SET last_seen_at = ? WHERE slug = ?").run(now, slug);
    } else {
      const count = Number((this.db.prepare("SELECT COUNT(*) AS n FROM bots").get() as Row).n);
      const name = slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ");
      this.db
        .prepare("INSERT INTO bots (slug, name, color, last_seen_at) VALUES (?, ?, ?, ?)")
        .run(slug, name, PALETTE[count % PALETTE.length], now);
    }
    return this.getBot(slug)!;
  }

  /** Create the bot's row if it's missing, without marking it as seen. */
  ensureBot(slug: string) {
    if (this.getBot(slug)) return;
    const count = Number((this.db.prepare("SELECT COUNT(*) AS n FROM bots").get() as Row).n);
    const name = slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ");
    this.db.prepare("INSERT INTO bots (slug, name, color) VALUES (?, ?, ?)").run(slug, name, PALETTE[count % PALETTE.length]);
  }

  getBot(slug: string): Bot | null {
    const r = this.db.prepare("SELECT * FROM bots WHERE slug = ?").get(slug);
    return r ? toBot(r as Row) : null;
  }

  listBots(): Bot[] {
    return this.db.prepare("SELECT * FROM bots ORDER BY slug").all().map((r) => toBot(r as Row));
  }

  updateBot(slug: string, patch: { name?: string; color?: string; webhookUrl?: string; webhookToken?: string }) {
    const before = this.touchBot(slug);
    if (patch.name !== undefined) this.db.prepare("UPDATE bots SET name = ? WHERE slug = ?").run(patch.name, slug);
    if (patch.color !== undefined) this.db.prepare("UPDATE bots SET color = ? WHERE slug = ?").run(patch.color, slug);
    if (patch.webhookUrl !== undefined) {
      this.db.prepare("UPDATE bots SET webhook_url = ? WHERE slug = ?").run(patch.webhookUrl, slug);
      // A key belongs to one destination: never send the old key to a new URL.
      if (patch.webhookUrl !== before.webhookUrl && patch.webhookToken === undefined) {
        this.db.prepare("UPDATE bots SET webhook_token = '' WHERE slug = ?").run(slug);
      }
    }
    if (patch.webhookToken !== undefined) {
      this.db.prepare("UPDATE bots SET webhook_token = ? WHERE slug = ?").run(patch.webhookToken, slug);
    }
    return this.getBot(slug)!;
  }

  /** Record a complete scan. `startedAt` is when the scan began, so the next one looks back to there. */
  markScan(slug: string, startedAt?: number, schedule?: string[]) {
    this.touchBot(slug);
    const at = startedAt && startedAt <= this.now() ? startedAt : this.now();
    this.db.prepare("UPDATE bots SET last_scan_at = ?, refresh_requested_at = NULL WHERE slug = ?").run(at, slug);
    if (schedule) this.db.prepare("UPDATE bots SET schedule = ? WHERE slug = ?").run(schedule.join(" "), slug);
  }

  /** Bots with a webhook and a refresh request from the last `withinMs` that they haven't answered with a scan. */
  botsWithPendingRefresh(withinMs: number): string[] {
    return (this.db.prepare("SELECT slug FROM bots WHERE refresh_requested_at > ? AND webhook_url != ''").all(this.now() - withinMs) as Row[])
      .map((r) => String(r.slug));
  }

  clearRefresh(slug: string) {
    this.db.prepare("UPDATE bots SET refresh_requested_at = NULL WHERE slug = ?").run(slug);
  }

  requestRefresh(slug?: string): Bot[] {
    if (slug) this.db.prepare("UPDATE bots SET refresh_requested_at = ? WHERE slug = ?").run(this.now(), slug);
    else this.db.prepare("UPDATE bots SET refresh_requested_at = ?").run(this.now());
    return this.listBots();
  }

  // Items

  getItem(id: number): Item | null {
    const r = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id);
    return r ? toItem(r as Row) : null;
  }

  getItemByKey(bot: string, key: string): Item | null {
    const r = this.db.prepare("SELECT * FROM items WHERE bot = ? AND key = ?").get(bot, key);
    return r ? toItem(r as Row) : null;
  }

  /**
   * Create an item, or update the one with the same bot and key.
   * A closed item stays closed unless it's a catch-up summary whose text changed,
   * or the bot passes reopen: true. That stops a bot from resurrecting things you dismissed.
   */
  upsertItem(input: ItemInput, opts: { asServer?: boolean } = {}): { item: Item; created: boolean; reopened: boolean; ignored: boolean } {
    return this.tx(() => {
      // A card the server writes for a bot (from triage) doesn't count as the bot checking in.
      if (opts.asServer) this.ensureBot(input.bot);
      else this.touchBot(input.bot);
      const now = this.now();
      const fields = {
        section: input.section,
        kind: input.kind,
        title: input.title,
        body: input.body ?? "",
        context: input.context ?? "",
        source: input.source ?? "",
        app: input.app ?? "",
        link: input.link ?? "",
        urgent: input.urgent ?? "",
        count_label: input.countLabel ?? "",
        options: JSON.stringify(input.options ?? []),
        draft: input.draft ? JSON.stringify(input.draft) : null,
      };
      const existing = input.key ? this.getItemByKey(input.bot, input.key) : null;
      if (!existing) {
        const res = this.db
          .prepare(
            `INSERT INTO items (bot, key, section, kind, title, body, context, source, app, link, urgent, count_label, options, draft, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
          )
          .run(
            input.bot, input.key ?? null, fields.section, fields.kind, fields.title, fields.body, fields.context,
            fields.source, fields.app, fields.link, fields.urgent, fields.count_label, fields.options, fields.draft, now, now,
          );
        return { item: this.getItem(Number(res.lastInsertRowid))!, created: true, reopened: false, ignored: false };
      }
      const changed =
        existing.section !== fields.section || existing.kind !== fields.kind || existing.title !== fields.title ||
        existing.body !== fields.body || existing.context !== fields.context || existing.source !== fields.source ||
        existing.app !== fields.app || existing.link !== fields.link || existing.urgent !== fields.urgent ||
        existing.countLabel !== fields.count_label || JSON.stringify(existing.options) !== fields.options ||
        JSON.stringify(existing.draft) !== (fields.draft ?? "null");
      let reopen = false;
      if (existing.status === "closed") {
        reopen = input.reopen === true || (existing.section === "catchup" && changed);
        if (!reopen) return { item: existing, created: false, reopened: false, ignored: true };
      }
      if (changed) {
        this.db
          .prepare(
            `UPDATE items SET section = ?, kind = ?, title = ?, body = ?, context = ?, source = ?, app = ?, link = ?, urgent = ?,
               count_label = ?, options = ?, draft = ?, rev = rev + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            fields.section, fields.kind, fields.title, fields.body, fields.context, fields.source, fields.app, fields.link,
            fields.urgent, fields.count_label, fields.options, fields.draft, now, existing.id,
          );
      }
      if (reopen) {
        this.db
          .prepare(
            "UPDATE items SET status = 'open', closed_at = NULL, closed_reason = '', resolution = '', error = '', acked_at = NULL, snoozed_until = NULL, updated_at = ? WHERE id = ?",
          )
          .run(now, existing.id);
      }
      return { item: this.getItem(existing.id)!, created: false, reopened: reopen, ignored: false };
    });
  }

  closeItem(id: number, reason: string, resolution = "") {
    const now = this.now();
    this.db
      .prepare(
        "UPDATE items SET status = 'closed', closed_reason = ?, resolution = ?, closed_at = ?, snoozed_until = NULL WHERE id = ?",
      )
      .run(reason, resolution, now, id);
    this.cancelOpenActions(id);
    return this.getItem(id);
  }

  snoozeItem(id: number, until: number) {
    this.db.prepare("UPDATE items SET status = 'snoozed', snoozed_until = ? WHERE id = ?").run(until, id);
    this.cancelOpenActions(id);
    return this.getItem(id);
  }

  /** Cancel actions still inside the undo window or not yet taken by the bot. */
  cancelOpenActions(itemId: number) {
    this.db
      .prepare("UPDATE actions SET status = 'cancelled', finished_at = ? WHERE item_id = ? AND status IN ('queued', 'ready')")
      .run(this.now(), itemId);
  }

  reopenItem(id: number, error = "") {
    this.db
      .prepare(
        "UPDATE items SET status = 'open', snoozed_until = NULL, closed_at = NULL, closed_reason = '', resolution = '', error = ?, acked_at = NULL WHERE id = ?",
      )
      .run(error, id);
    return this.getItem(id);
  }

  ackItem(id: number) {
    this.db.prepare("UPDATE items SET acked_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Bring snoozed items back once their time has come. */
  wakeSnoozed(): number {
    const res = this.db
      .prepare("UPDATE items SET status = 'open', snoozed_until = NULL WHERE status = 'snoozed' AND snoozed_until <= ?")
      .run(this.now());
    return Number(res.changes);
  }

  listItems(filter: { bot?: string; section?: Section; status?: ItemStatus | "all"; since?: number } = {}): Item[] {
    const where: string[] = ["NOT (status = 'closed' AND title = '')"];
    const args: (string | number)[] = [];
    if (filter.bot) { where.push("bot = ?"); args.push(filter.bot); }
    if (filter.section) { where.push("section = ?"); args.push(filter.section); }
    if (filter.status && filter.status !== "all") { where.push("status = ?"); args.push(filter.status); }
    if (filter.since) { where.push("updated_at >= ?"); args.push(filter.since); }
    const sql = `SELECT * FROM items WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`;
    return this.db.prepare(sql).all(...args).map((r) => toItem(r as Row));
  }

  /** Open and snoozed cards of one bot, without the 500 cap of listItems. */
  liveItemsOf(bot: string): Item[] {
    return this.db.prepare("SELECT * FROM items WHERE bot = ? AND status IN ('open', 'snoozed')").all(bot).map((r) => toItem(r as Row));
  }

  /** What the Today page shows. */
  activeItems(recentMs: number): Item[] {
    const since = this.now() - recentMs;
    return this.db
      .prepare(
        `SELECT * FROM items
         WHERE status IN ('open', 'pending')
            OR (status = 'closed' AND closed_reason = 'action' AND closed_at >= ? AND acked_at IS NULL)
            OR (section = 'catchup' AND status = 'closed' AND closed_reason = 'read' AND closed_at >= ?)
         ORDER BY (urgent != '') DESC, updated_at DESC, id DESC`,
      )
      .all(since, since)
      .map((r) => toItem(r as Row));
  }

  archive(q: string, days: number, limit = 50, offset = 0, bot = ""): { items: Item[]; more: boolean } {
    const since = this.now() - days * 86_400_000;
    const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM items
         WHERE ((status = 'closed' AND closed_at >= ? AND title != '') OR status = 'snoozed')
           AND (? = '' OR bot = ?)
           AND (? = '' OR title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR context LIKE ? ESCAPE '\\'
                OR resolution LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\' OR draft LIKE ? ESCAPE '\\')
         ORDER BY COALESCE(closed_at, updated_at) DESC LIMIT ? OFFSET ?`,
      )
      .all(since, bot, bot, q, like, like, like, like, like, like, limit + 1, offset)
      .map((r) => toItem(r as Row));
    return { items: rows.slice(0, limit), more: rows.length > limit };
  }

  /**
   * Drop archived content after `days`. Cards with a key keep an empty row (a few bytes),
   * so a bot reposting an old key never brings back something you dismissed.
   */
  purge(days: number): number {
    const before = this.now() - days * 86_400_000;
    const res = this.db.prepare("DELETE FROM items WHERE status = 'closed' AND closed_at < ? AND key IS NULL").run(before);
    this.db
      .prepare(
        `UPDATE items SET title = '', body = '', context = '', options = '[]', draft = NULL, resolution = '', link = ''
         WHERE status = 'closed' AND closed_at < ? AND key IS NOT NULL AND title != ''`,
      )
      .run(before);
    this.db.prepare("DELETE FROM actions WHERE finished_at IS NOT NULL AND finished_at < ?").run(before);
    this.db.prepare("DELETE FROM triage WHERE decided_at < ?").run(before);
    this.db.prepare("DELETE FROM wakes WHERE at < ?").run(before);
    return Number(res.changes);
  }

  // Actions

  addAction(a: {
    item?: Item | null; todoId?: string | null; todoDue?: string; bot: string; type: ActionType;
    label?: string; instruction?: string; text?: string; delayMs: number;
  }): Action {
    return this.tx(() => {
      const now = this.now();
      const i = a.item;
      const snapshot: Snapshot | null = i
        ? { id: i.id, key: i.key, rev: i.rev, title: i.title, body: i.body, context: i.context, source: i.source, app: i.app, link: i.link, draft: i.draft, status: i.status }
        : a.todoId != null ? ({ todoDue: a.todoDue ?? "" } as Snapshot) : null;
      const res = this.db
        .prepare(
          `INSERT INTO actions (item_id, todo_id, bot, type, label, instruction, text, snapshot, status, run_after, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          i?.id ?? null, a.todoId ?? null, a.bot, a.type, a.label ?? "", a.instruction ?? "", a.text ?? "",
          snapshot ? JSON.stringify(snapshot) : null, now + a.delayMs, now,
        );
      if (i) this.db.prepare("UPDATE items SET status = 'pending', error = '' WHERE id = ?").run(i.id);
      return this.getAction(Number(res.lastInsertRowid))!;
    });
  }

  getAction(id: number): Action | null {
    const r = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
    return r ? toAction(r as Row) : null;
  }

  pendingActionFor(itemId: number): Action | null {
    const r = this.db
      .prepare("SELECT * FROM actions WHERE item_id = ? AND status IN ('queued', 'ready', 'claimed') ORDER BY id DESC LIMIT 1")
      .get(itemId);
    return r ? toAction(r as Row) : null;
  }

  pendingTodoAction(bot: string, todoId: string): Action | null {
    const r = this.db
      .prepare("SELECT * FROM actions WHERE bot = ? AND todo_id = ? AND type = 'complete_todo' AND status IN ('queued', 'ready', 'claimed') ORDER BY id DESC LIMIT 1")
      .get(bot, todoId);
    return r ? toAction(r as Row) : null;
  }

  /** Clear a to-do's local completion, but only if it's still the occurrence this action completed. */
  clearTodoFor(a: Action) {
    if (!a.todoId) return;
    const due = a.snapshot?.todoDue;
    if (due === undefined) {
      this.db.prepare("UPDATE todos SET completed_at = NULL, completed_due = NULL WHERE bot = ? AND id = ?").run(a.bot, a.todoId);
    } else {
      this.db
        .prepare("UPDATE todos SET completed_at = NULL, completed_due = NULL WHERE bot = ? AND id = ? AND completed_due = ?")
        .run(a.bot, a.todoId, due);
    }
  }

  /** Undo works only while the action is still inside its undo window. */
  cancelAction(id: number): Action | null {
    return this.tx(() => {
      const a = this.getAction(id);
      if (!a || a.status !== "queued") return null;
      this.db.prepare("UPDATE actions SET status = 'cancelled', finished_at = ? WHERE id = ?").run(this.now(), id);
      if (a.itemId) {
        // A read summary goes back to read, unless it got new content in the meantime.
        const item = this.getItem(a.itemId);
        const back = a.snapshot?.status === "closed" && item?.rev === a.snapshot.rev ? "closed" : "open";
        this.db.prepare("UPDATE items SET status = ? WHERE id = ? AND status = 'pending'").run(back, a.itemId);
      }
      this.clearTodoFor(a);
      return this.getAction(id);
    });
  }

  /** Move actions whose undo window has passed to ready. Returns the bots that now have work. */
  promoteDue(bot?: string): string[] {
    const filter = bot ? " AND bot = ?" : "";
    const args = bot ? [this.now(), bot] : [this.now()];
    const rows = this.db.prepare(`SELECT DISTINCT bot FROM actions WHERE status = 'queued' AND run_after <= ?${filter}`).all(...args) as Row[];
    if (rows.length) this.db.prepare(`UPDATE actions SET status = 'ready' WHERE status = 'queued' AND run_after <= ?${filter}`).run(...args);
    return rows.map((r) => String(r.bot));
  }

  /** Bots with actions from the last `withinMs` that are ready but nobody has taken. */
  botsWithReadyWork(withinMs: number): string[] {
    return (this.db.prepare("SELECT DISTINCT bot FROM actions WHERE status = 'ready' AND created_at > ?").all(this.now() - withinMs) as Row[])
      .map((r) => String(r.bot));
  }

  /** Hand this bot its ready actions. */
  claimActions(bot: string): Action[] {
    return this.tx(() => {
      const now = this.now();
      const rows = this.db
        .prepare("SELECT * FROM actions WHERE bot = ? AND status = 'ready' ORDER BY id LIMIT 50")
        .all(bot)
        .map((r) => toAction(r as Row));
      const claim = this.db.prepare("UPDATE actions SET status = 'claimed', claimed_at = ? WHERE id = ?");
      for (const a of rows) claim.run(now, a.id);
      return rows.map((a) => ({ ...a, status: "claimed" as const, claimedAt: now }));
    });
  }

  /**
   * A claimed action the bot never reported is not handed out again: it may already have
   * happened, and sending a message twice is worse than asking. The card comes back with a note.
   */
  expireClaims(staleMs: number): number {
    return this.tx(() => {
      const stale = this.db
        .prepare("SELECT * FROM actions WHERE status = 'claimed' AND claimed_at < ?")
        .all(this.now() - staleMs)
        .map((r) => toAction(r as Row));
      for (const a of stale) {
        this.db.prepare("UPDATE actions SET status = 'unknown' WHERE id = ?").run(a.id);
        if (a.itemId) {
          this.db
            .prepare("UPDATE items SET status = 'open', error = ? WHERE id = ? AND status = 'pending'")
            .run(`The bot took "${a.label}" but never confirmed it. Check whether it happened before you try again.`, a.itemId);
        }
        this.clearTodoFor(a);
      }
      return stale.length;
    });
  }

  /**
   * Record what the bot did. Only the bot that holds the action can report, and only once.
   * A late report on an action that went stale still counts, unless the card has moved on.
   */
  finishAction(id: number, bot: string, ok: boolean, result: string): { action: Action | null; error?: string } {
    return this.tx(() => {
      const a = this.getAction(id);
      if (!a || a.bot !== bot) return { action: null };
      if (a.status === "done" || a.status === "failed") return { action: a };
      if (a.status !== "claimed" && a.status !== "unknown") {
        return { action: a, error: `Action ${id} is ${a.status}. Only actions you took with grokdash actions can be reported.` };
      }
      const now = this.now();
      this.db.prepare("UPDATE actions SET status = ?, finished_at = ?, result = ? WHERE id = ?").run(ok ? "done" : "failed", now, result, id);
      const newer = a.itemId
        ? this.db.prepare("SELECT 1 FROM actions WHERE item_id = ? AND id > ? AND status NOT IN ('cancelled', 'failed')").get(a.itemId, id)
        : null;
      const current = a.itemId ? this.getItem(a.itemId) : null;
      // A card the user dismissed, finished or snoozed after the action went quiet stays that way.
      const userMovedOn = current && (current.status === "snoozed" || (current.status === "closed" && current.closedReason !== "action"));
      if (a.itemId && !newer && !userMovedOn) {
        const item = current;
        const changed = item && a.snapshot && item.rev !== a.snapshot.rev;
        if (ok && changed) {
          // The bot did what was asked, but the card has new content since: keep it open so it isn't lost.
          this.db
            .prepare("UPDATE items SET status = 'open', error = ? WHERE id = ?")
            .run(`Done for the earlier version: ${result || a.label}. The card has changed since, so check it again.`, a.itemId);
        } else if (ok) {
          this.db
            .prepare("UPDATE items SET status = 'closed', closed_reason = 'action', resolution = ?, closed_at = ?, error = '', acked_at = NULL WHERE id = ?")
            .run(result || a.label || "Done", now, a.itemId);
        } else {
          this.db.prepare("UPDATE items SET status = 'open', error = ? WHERE id = ?").run(result || "The bot couldn't do it.", a.itemId);
        }
      }
      if (!ok) this.clearTodoFor(a);
      return { action: this.getAction(id) };
    });
  }

  // Agenda

  /** Replace this bot's events that overlap [from, to). */
  replaceEvents(bot: string, from: string, to: string, events: Omit<CalEvent, "id" | "bot">[], touch = true) {
    this.tx(() => {
      // A calendar the dashboard reads itself isn't a bot, so it gets no filter chip.
      if (touch) this.touchBot(bot);
      this.db
        .prepare(`DELETE FROM events WHERE bot = ? AND ${OVERLAP}`)
        .run(bot, to, from, from, from + "T00:00:00");
      const ins = this.db.prepare("INSERT INTO events (bot, title, start, end, location, all_day, app) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const e of events) ins.run(bot, e.title, e.start, e.end, e.location, e.allDay ? 1 : 0, e.app);
    });
  }

  /** Events that overlap [from, to), including ones that started earlier and are still going. */
  listEvents(from: string, to: string): CalEvent[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE ${OVERLAP} ORDER BY start`)
      .all(to, from, from, from + "T00:00:00")
      .map((r) => {
        const row = r as Row;
        return {
          id: Number(row.id),
          bot: str(row.bot),
          title: str(row.title),
          start: str(row.start),
          end: str(row.end),
          location: str(row.location),
          allDay: Number(row.all_day) === 1,
          app: str(row.app),
        };
      });
  }

  // To-dos sent by a bot, for people without a direct Todoist link

  replaceTodos(bot: string, todos: Omit<BotTodo, "bot" | "completedAt">[]) {
    this.tx(() => {
      this.touchBot(bot);
      // A local completion survives the bot's next snapshot only for the same occurrence.
      // A recurring task that moved on to its next date shows up again.
      const done = new Map(
        (this.db.prepare("SELECT id, completed_at, completed_due FROM todos WHERE bot = ? AND completed_at IS NOT NULL").all(bot) as Row[])
          .map((r) => [String(r.id), { at: Number(r.completed_at), due: str(r.completed_due) }]),
      );
      this.db.prepare("DELETE FROM todos WHERE bot = ?").run(bot);
      const ins = this.db.prepare(
        "INSERT INTO todos (id, bot, content, priority, due, due_string, deadline, project, url, app, completed_at, completed_due) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const t of todos) {
        const d = done.get(t.id);
        const keep = d && d.due === t.due;
        ins.run(t.id, bot, t.content, t.priority, t.due, t.dueString, t.deadline, t.project, t.url, t.app, keep ? d.at : null, keep ? d.due : null);
      }
    });
  }

  listTodos(): BotTodo[] {
    return this.db.prepare("SELECT * FROM todos ORDER BY bot, id").all().map((r) => toTodo(r as Row));
  }

  findTodo(bot: string, id: string): BotTodo | null {
    const r = this.db.prepare("SELECT * FROM todos WHERE bot = ? AND id = ?").get(bot, id);
    return r ? toTodo(r as Row) : null;
  }

  setTodoCompleted(bot: string, id: string, completed: boolean) {
    this.db
      .prepare("UPDATE todos SET completed_at = ?, completed_due = CASE WHEN ? THEN due ELSE NULL END WHERE bot = ? AND id = ?")
      .run(completed ? this.now() : null, completed ? 1 : 0, bot, id);
  }
}
