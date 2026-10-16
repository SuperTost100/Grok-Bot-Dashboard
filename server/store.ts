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
export type ActionType = "choose" | "send" | "write" | "complete_todo" | "panel" | "closed" | "refresh";

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
  /** When the page first showed it. Expiry counts from here, so days you don't look don't count. */
  seenAt: number | null;
  /** Past this time it's out of date (an event that happened), so it goes to the archive. */
  expiresAt: number | null;
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
  /** bot: a Grok bot. addon and app: installed from a store. source: the dashboard's own reader (PoliTO). */
  kind: BotKind;
  /** On the Bots page and in the bot strip. Behind-the-scenes bots still post cards that need you. */
  shown: boolean;
  /** What a bot may read beyond its own cards: "agenda", "todos", "cards". */
  reads: ReadScope[];
  /** One line on what it does, for its page. */
  role: string;
}

export type BotKind = "bot" | "addon" | "app" | "source";
export const READ_SCOPES = ["agenda", "todos", "cards"] as const;
export type ReadScope = (typeof READ_SCOPES)[number];

/** An add-on or app installed from a store. */
export interface AddonRow {
  id: string;
  type: "addon" | "app";
  manifest: unknown;
  repo: string;
  branch: string;
  path: string;
  /** The commit it was installed from, and the newest commit that touched its folder then. */
  sha: string;
  pathSha: string;
  trusted: boolean;
  enabled: boolean;
  settings: Record<string, string | number | boolean>;
  tokenHash: string;
  /** One line from the add-on itself, like "Read 2 min ago" or an error. */
  status: string;
  statusOk: boolean;
  /** A newer commit for its folder, and what those commits say. */
  updateSha: string;
  updateNotes: string[];
  checkedAt: number | null;
  installedAt: number;
  updatedAt: number;
}

/** Work one bot (or add-on) leaves for another, delivered with the receiver's next run. */
export interface Handoff {
  id: number;
  from: string;
  to: string;
  text: string;
  urgent: boolean;
  status: "queued" | "sent" | "done" | "failed" | "cancelled";
  attempts: number;
  result: string;
  createdAt: number;
  sentAt: number | null;
  doneAt: number | null;
}

/** What a bot, add-on or app shows on its page and, when pinned, on Today. */
export interface Panel {
  owner: string;
  title: string;
  blocks: PanelBlock[];
  pinned: boolean;
  updatedAt: number;
}

export type PanelBlock =
  | { type: "text"; text: string }
  | { type: "stats"; items: { label: string; value: string }[] }
  | { type: "list"; items: { title: string; sub?: string; link?: string; badge?: string }[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "buttons"; items: { label: string; instruction?: string }[] }
  | { type: "image"; src: string; alt: string };

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
  /** How long it takes, in minutes, when the list knows (Todoist's duration). 0 when it doesn't. */
  duration: number;
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
CREATE TABLE IF NOT EXISTS addons (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  manifest TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  sha TEXT NOT NULL,
  path_sha TEXT NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}',
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  status_ok INTEGER NOT NULL DEFAULT 1,
  update_sha TEXT NOT NULL DEFAULT '',
  update_notes TEXT NOT NULL DEFAULT '[]',
  checked_at INTEGER,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_bot TEXT NOT NULL,
  to_bot TEXT NOT NULL,
  text TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  done_at INTEGER,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS handoffs_to ON handoffs (to_bot, status);
CREATE TABLE IF NOT EXISTS panels (
  owner TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  blocks TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
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
  ["items", "seen_at", "INTEGER"],
  ["items", "expires_at", "INTEGER"],
  ["bots", "kind", "TEXT NOT NULL DEFAULT 'bot'"],
  ["bots", "shown", "INTEGER NOT NULL DEFAULT 0"],
  ["bots", "reads", "TEXT NOT NULL DEFAULT '[]'"],
  ["bots", "role", "TEXT NOT NULL DEFAULT ''"],
  ["todos", "duration", "INTEGER NOT NULL DEFAULT 0"],
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
    seenAt: num(r.seen_at),
    expiresAt: num(r.expires_at),
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
    kind: (str(r.kind) || "bot") as BotKind,
    shown: Boolean(r.shown),
    reads: JSON.parse(str(r.reads) || "[]"),
    role: str(r.role),
  };
}

function toAddon(r: Row): AddonRow {
  return {
    id: str(r.id), type: str(r.type) as AddonRow["type"], manifest: JSON.parse(str(r.manifest)), repo: str(r.repo), branch: str(r.branch), path: str(r.path),
    sha: str(r.sha), pathSha: str(r.path_sha), trusted: Boolean(r.trusted), enabled: Boolean(r.enabled), settings: JSON.parse(str(r.settings) || "{}"),
    tokenHash: str(r.token_hash), status: str(r.status), statusOk: Boolean(r.status_ok), updateSha: str(r.update_sha),
    updateNotes: JSON.parse(str(r.update_notes) || "[]"), checkedAt: num(r.checked_at), installedAt: Number(r.installed_at), updatedAt: Number(r.updated_at),
  };
}

function toHandoff(r: Row): Handoff {
  return {
    id: Number(r.id), from: str(r.from_bot), to: str(r.to_bot), text: str(r.text), urgent: Boolean(r.urgent),
    status: str(r.status) as Handoff["status"], attempts: Number(r.attempts), result: str(r.result),
    createdAt: Number(r.created_at), sentAt: num(r.sent_at), doneAt: num(r.done_at),
  };
}

function toPanel(r: Row): Panel {
  return { owner: str(r.owner), title: str(r.title), blocks: JSON.parse(str(r.blocks) || "[]"), pinned: Boolean(r.pinned), updatedAt: Number(r.updated_at) };
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
    duration: Number(row.duration ?? 0),
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
  expiresAt?: number | null;
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

  /** Messages after an id, oldest first, for add-ons that read mail and chats. */
  inboxAfter(afterId: number, sourcePrefix: string, limit: number): InboxMessage[] {
    return this.db
      .prepare("SELECT * FROM inbox WHERE id > ? AND (? = '' OR source = ? OR source LIKE ? ESCAPE '\\') ORDER BY id LIMIT ?")
      .all(afterId, sourcePrefix, sourcePrefix, sourcePrefix.replace(/[%_\\]/g, (c) => "\\" + c) + ":%", limit)
      .map((r) => toInbox(r as Row));
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
  /** Cards for chats Grok still has to answer (calendar chores aside): they need you even before Grok writes. */
  awaitingGrok(): Set<number> {
    const rows = this.db.prepare("SELECT item_id FROM triage WHERE grok IN ('queued', 'sent') AND route != 'calendar' AND item_id IS NOT NULL").all();
    return new Set(rows.map((r) => Number((r as Row).item_id)));
  }

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

  /** Your choices about a bot from the page: these never count as the bot checking in. */
  configureBot(slug: string, patch: { shown?: boolean; reads?: ReadScope[]; role?: string; kind?: BotKind; name?: string; color?: string; webhookUrl?: string; webhookToken?: string }) {
    this.ensureBot(slug);
    if (patch.webhookUrl !== undefined) {
      const before = this.getBot(slug)!;
      this.db.prepare("UPDATE bots SET webhook_url = ? WHERE slug = ?").run(patch.webhookUrl, slug);
      // A key belongs to one destination: never send the old key to a new URL.
      if (patch.webhookUrl !== before.webhookUrl && patch.webhookToken === undefined) this.db.prepare("UPDATE bots SET webhook_token = '' WHERE slug = ?").run(slug);
    }
    if (patch.webhookToken !== undefined) this.db.prepare("UPDATE bots SET webhook_token = ? WHERE slug = ?").run(patch.webhookToken, slug);
    if (patch.shown !== undefined) this.db.prepare("UPDATE bots SET shown = ? WHERE slug = ?").run(patch.shown ? 1 : 0, slug);
    if (patch.reads !== undefined) this.db.prepare("UPDATE bots SET reads = ? WHERE slug = ?").run(JSON.stringify(patch.reads), slug);
    if (patch.role !== undefined) this.db.prepare("UPDATE bots SET role = ? WHERE slug = ?").run(patch.role, slug);
    if (patch.kind !== undefined) this.db.prepare("UPDATE bots SET kind = ? WHERE slug = ?").run(patch.kind, slug);
    if (patch.name !== undefined) this.db.prepare("UPDATE bots SET name = ? WHERE slug = ?").run(patch.name, slug);
    if (patch.color !== undefined) this.db.prepare("UPDATE bots SET color = ? WHERE slug = ?").run(patch.color, slug);
    return this.getBot(slug)!;
  }

  // Add-ons and apps

  listAddons(): AddonRow[] {
    return this.db.prepare("SELECT * FROM addons ORDER BY id").all().map((r) => toAddon(r as Row));
  }

  getAddon(id: string): AddonRow | null {
    const r = this.db.prepare("SELECT * FROM addons WHERE id = ?").get(id) as Row | undefined;
    return r ? toAddon(r) : null;
  }

  addonByToken(hash: string): AddonRow | null {
    const r = this.db.prepare("SELECT * FROM addons WHERE token_hash = ?").get(hash) as Row | undefined;
    return r ? toAddon(r) : null;
  }

  saveAddon(a: AddonRow) {
    this.db
      .prepare(
        `INSERT INTO addons (id, type, manifest, repo, branch, path, sha, path_sha, trusted, enabled, settings, token_hash, status, status_ok, update_sha, update_notes, checked_at, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET type = excluded.type, manifest = excluded.manifest, repo = excluded.repo, branch = excluded.branch,
           path = excluded.path, sha = excluded.sha, path_sha = excluded.path_sha, trusted = excluded.trusted, enabled = excluded.enabled,
           settings = excluded.settings, token_hash = excluded.token_hash, status = excluded.status, status_ok = excluded.status_ok,
           update_sha = excluded.update_sha, update_notes = excluded.update_notes, checked_at = excluded.checked_at, updated_at = excluded.updated_at`,
      )
      .run(
        a.id, a.type, JSON.stringify(a.manifest), a.repo, a.branch, a.path, a.sha, a.pathSha, a.trusted ? 1 : 0, a.enabled ? 1 : 0,
        JSON.stringify(a.settings), a.tokenHash, a.status, a.statusOk ? 1 : 0, a.updateSha, JSON.stringify(a.updateNotes), a.checkedAt, a.installedAt, a.updatedAt,
      );
    return this.getAddon(a.id)!;
  }

  setAddonStatus(id: string, status: string, ok: boolean) {
    this.db.prepare("UPDATE addons SET status = ?, status_ok = ? WHERE id = ?").run(status, ok ? 1 : 0, id);
  }

  deleteAddon(id: string) {
    this.db.prepare("DELETE FROM addons WHERE id = ?").run(id);
  }

  // Handoffs

  addHandoff(from: string, to: string, text: string, urgent: boolean): Handoff {
    const res = this.db
      .prepare("INSERT INTO handoffs (from_bot, to_bot, text, urgent, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(from, to, text, urgent ? 1 : 0, this.now());
    return this.getHandoff(Number(res.lastInsertRowid))!;
  }

  getHandoff(id: number): Handoff | null {
    const r = this.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Row | undefined;
    return r ? toHandoff(r) : null;
  }

  queuedHandoffs(to: string): Handoff[] {
    return this.db.prepare("SELECT * FROM handoffs WHERE to_bot = ? AND status = 'queued' ORDER BY id").all(to).map((r) => toHandoff(r as Row));
  }

  /** Bots with handoffs waiting, for the wake loop. */
  botsWithHandoffs(): string[] {
    return this.db.prepare("SELECT DISTINCT to_bot FROM handoffs WHERE status = 'queued'").all().map((r) => str((r as Row).to_bot));
  }

  /** The receiver takes its waiting handoffs. Each is handed out at most twice before it fails. */
  claimHandoffs(to: string): Handoff[] {
    return this.tx(() => {
      const list = this.queuedHandoffs(to);
      const stmt = this.db.prepare("UPDATE handoffs SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?");
      for (const h of list) stmt.run(this.now(), h.id);
      return list.map((h) => ({ ...h, status: "sent" as const, sentAt: this.now(), attempts: h.attempts + 1 }));
    });
  }

  finishHandoff(id: number, to: string, ok: boolean, result: string): Handoff | null {
    const h = this.getHandoff(id);
    if (!h || h.to !== to || h.status !== "sent") return null;
    this.db.prepare("UPDATE handoffs SET status = ?, result = ?, done_at = ? WHERE id = ?").run(ok ? "done" : "failed", result, this.now(), id);
    return this.getHandoff(id);
  }

  /** Handed out but never reported: back in line, or failed after the second try. */
  expireHandoffClaims(before: number, maxAttempts = 2) {
    this.db.prepare("UPDATE handoffs SET status = 'failed', result = 'Never reported back', done_at = ? WHERE status = 'sent' AND sent_at < ? AND attempts >= ?").run(this.now(), before, maxAttempts);
    this.db.prepare("UPDATE handoffs SET status = 'queued' WHERE status = 'sent' AND sent_at < ?").run(before);
  }

  /** Finished handoffs the sender hasn't seen yet. Reading them marks them seen. */
  takeHandoffResults(from: string): Handoff[] {
    return this.tx(() => {
      const list = this.db.prepare("SELECT * FROM handoffs WHERE from_bot = ? AND status IN ('done', 'failed') AND delivered_at IS NULL ORDER BY id").all(from).map((r) => toHandoff(r as Row));
      const stmt = this.db.prepare("UPDATE handoffs SET delivered_at = ? WHERE id = ?");
      for (const h of list) stmt.run(this.now(), h.id);
      return list;
    });
  }

  /** Handoffs to or from a bot since a time, newest first, for its page. */
  handoffsOf(bot: string, since: number): Handoff[] {
    return this.db
      .prepare("SELECT * FROM handoffs WHERE (from_bot = ? OR to_bot = ?) AND created_at >= ? ORDER BY id DESC LIMIT 20")
      .all(bot, bot, since)
      .map((r) => toHandoff(r as Row));
  }

  /** Every bot's runs since a time: the weekly cap counts them all. */
  allWakesSince(since: number): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM wakes WHERE at >= ?").get(since) as Row).n);
  }

  // Panels

  setPanel(owner: string, title: string, blocks: PanelBlock[]): Panel {
    this.db
      .prepare(
        `INSERT INTO panels (owner, title, blocks, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (owner) DO UPDATE SET title = excluded.title, blocks = excluded.blocks, updated_at = excluded.updated_at`,
      )
      .run(owner, title, JSON.stringify(blocks), this.now());
    return this.getPanel(owner)!;
  }

  getPanel(owner: string): Panel | null {
    const r = this.db.prepare("SELECT * FROM panels WHERE owner = ?").get(owner) as Row | undefined;
    return r ? toPanel(r) : null;
  }

  listPanels(): Panel[] {
    return this.db.prepare("SELECT * FROM panels ORDER BY owner").all().map((r) => toPanel(r as Row));
  }

  deletePanel(owner: string) {
    this.db.prepare("DELETE FROM panels WHERE owner = ?").run(owner);
  }

  pinPanel(owner: string, pinned: boolean) {
    this.db.prepare("UPDATE panels SET pinned = ? WHERE owner = ?").run(pinned ? 1 : 0, owner);
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
        expires_at: input.expiresAt ?? null,
      };
      const existing = input.key ? this.getItemByKey(input.bot, input.key) : null;
      if (!existing) {
        const res = this.db
          .prepare(
            `INSERT INTO items (bot, key, section, kind, title, body, context, source, app, link, urgent, count_label, options, draft, expires_at, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
          )
          .run(
            input.bot, input.key ?? null, fields.section, fields.kind, fields.title, fields.body, fields.context,
            fields.source, fields.app, fields.link, fields.urgent, fields.count_label, fields.options, fields.draft, fields.expires_at, now, now,
          );
        return { item: this.getItem(Number(res.lastInsertRowid))!, created: true, reopened: false, ignored: false };
      }
      const changed =
        existing.section !== fields.section || existing.kind !== fields.kind || existing.title !== fields.title ||
        existing.body !== fields.body || existing.context !== fields.context || existing.source !== fields.source ||
        existing.app !== fields.app || existing.link !== fields.link || existing.urgent !== fields.urgent ||
        existing.countLabel !== fields.count_label || JSON.stringify(existing.options) !== fields.options ||
        JSON.stringify(existing.draft) !== (fields.draft ?? "null") || existing.expiresAt !== fields.expires_at;
      let reopen = false;
      if (existing.status === "closed") {
        reopen = input.reopen === true || (existing.section === "catchup" && changed);
        if (!reopen) return { item: existing, created: false, reopened: false, ignored: true };
      }
      if (changed) {
        this.db
          .prepare(
            `UPDATE items SET section = ?, kind = ?, title = ?, body = ?, context = ?, source = ?, app = ?, link = ?, urgent = ?,
               count_label = ?, options = ?, draft = ?, expires_at = ?, rev = rev + 1, updated_at = ?, seen_at = NULL
             WHERE id = ?`,
          )
          .run(
            fields.section, fields.kind, fields.title, fields.body, fields.context, fields.source, fields.app, fields.link,
            fields.urgent, fields.count_label, fields.options, fields.draft, fields.expires_at, now, existing.id,
          );
      }
      if (reopen) {
        this.db
          .prepare(
            "UPDATE items SET status = 'open', closed_at = NULL, closed_reason = '', resolution = '', error = '', acked_at = NULL, snoozed_until = NULL, seen_at = NULL, updated_at = ? WHERE id = ?",
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
        "UPDATE items SET status = 'open', snoozed_until = NULL, closed_at = NULL, closed_reason = '', resolution = '', error = ?, acked_at = NULL, seen_at = NULL WHERE id = ?",
      )
      .run(error, id);
    return this.getItem(id);
  }

  ackItem(id: number) {
    this.db.prepare("UPDATE items SET acked_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** The page showed these: their expiry clock starts now, unless it already started. */
  markSeen(ids: number[]) {
    const stmt = this.db.prepare("UPDATE items SET seen_at = ? WHERE id = ? AND seen_at IS NULL AND status = 'open'");
    this.tx(() => { for (const id of ids) stmt.run(this.now(), id); });
  }

  /**
   * File what you've had on screen long enough without acting on it, and what's out of date.
   * The clock starts when the page first showed an item, or when you came back from Away, whichever is later.
   */
  expireStale(o: { infoMs: number; cardMs: number; clockFrom: number }): number {
    const now = this.now();
    const ids = this.db
      .prepare(
        `SELECT id FROM items WHERE status = 'open' AND (
           (expires_at IS NOT NULL AND expires_at <= ?)
           OR (seen_at IS NOT NULL AND max(seen_at, ?) <= ? - CASE WHEN kind IN ('choice', 'draft') THEN ? ELSE ? END))`,
      )
      .all(now, o.clockFrom, now, o.cardMs, o.infoMs)
      .map((r) => Number((r as Row).id));
    for (const id of ids) {
      const item = this.getItem(id)!;
      const past = item.expiresAt != null && item.expiresAt <= now;
      this.closeItem(id, "expired", past ? "Out of date" : item.kind === "choice" || item.kind === "draft" ? "Expired without an answer" : "Expired unread");
    }
    return ids.length;
  }

  /** Away mode: from and until (epoch ms), and whether you've seen the summary since coming back. */
  getAway(): { from: number; until: number; summarized: boolean } | null {
    const raw = this.getState("away");
    return raw ? JSON.parse(raw) : null;
  }

  setAway(away: { from: number; until: number; summarized: boolean } | null) {
    this.setState("away", away ? JSON.stringify(away) : null);
  }

  isAway(): boolean {
    const a = this.getAway();
    return Boolean(a && a.from <= this.now() && this.now() < a.until);
  }

  /** Bring snoozed items back once their time has come. */
  wakeSnoozed(): number {
    const res = this.db
      .prepare("UPDATE items SET status = 'open', snoozed_until = NULL, seen_at = NULL WHERE status = 'snoozed' AND snoozed_until <= ?")
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
            OR (status = 'closed' AND closed_reason = 'read' AND closed_at >= ?)
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
    this.db.prepare("DELETE FROM handoffs WHERE created_at < ? AND status NOT IN ('queued', 'sent')").run(before);
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

  /** Panel button presses not finished yet, so the page can show them with Undo. */
  openPanelActions(): Action[] {
    return this.db.prepare("SELECT * FROM actions WHERE type = 'panel' AND status IN ('queued', 'ready', 'claimed') ORDER BY id").all().map((r) => toAction(r as Row));
  }

  /** Bots holding taps they took and haven't reported yet: they're working. */
  busyBots(): Set<string> {
    return new Set(this.db.prepare("SELECT DISTINCT bot FROM actions WHERE status = 'claimed'").all().map((r) => str((r as Row).bot)));
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

  replaceTodos(bot: string, todos: (Omit<BotTodo, "bot" | "completedAt" | "duration"> & { duration?: number })[]) {
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
        "INSERT INTO todos (id, bot, content, priority, due, due_string, deadline, project, url, app, duration, completed_at, completed_due) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const t of todos) {
        const d = done.get(t.id);
        const keep = d && d.due === t.due;
        ins.run(t.id, bot, t.content, t.priority, t.due, t.dueString, t.deadline, t.project, t.url, t.app, t.duration ?? 0, keep ? d.at : null, keep ? d.due : null);
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
