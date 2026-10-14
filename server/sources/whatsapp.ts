// Reads WhatsApp through WAHA (https://waha.devlike.pro), a bridge that links to your account as a
// device, like WhatsApp Web. The dashboard only reads: it never sends, marks read or changes a chat.
// It polls the chat list and fetches messages newer than the last run. Each WhatsApp number needs
// its own WAHA: the free edition links one account per container.

import type { InboxInput, Store } from "../store.ts";
import { FIRST_LOOK_BACK_MS } from "./mail.ts";

type Fetch = typeof fetch;

export const SESSION = "default";
const PAGE = 100;
/** Pages of one chat read per run. A chat with more waits for the next run. */
const MAX_PAGES = 10;
const MAX_TEXT = 4000;

export interface WaStatus {
  /** WAHA's session status: STOPPED, STARTING, SCAN_QR_CODE, WORKING or FAILED. "MISSING" before the session exists. */
  status: string;
  /** The linked phone number, once linked. */
  me: string;
}

interface ChatSummary {
  id: string;
  name?: string | null;
  lastMessage?: { timestamp?: number } | null;
}

interface WaMessage {
  id: string;
  timestamp: number;
  from?: string;
  to?: string;
  fromMe: boolean;
  participant?: string | null;
  body?: string | null;
  hasMedia?: boolean;
  _data?: { pushName?: string; verifiedBizName?: string } | null;
}

export class Waha {
  base: string;
  key: string;
  fetch: Fetch;

  constructor(base: string, key: string, fetchImpl: Fetch = fetch) {
    this.base = base.replace(/\/+$/, "");
    this.key = key;
    this.fetch = fetchImpl;
  }

  async call(method: string, path: string, body?: unknown, raw = false): Promise<unknown> {
    const res = await this.fetch(this.base + path, {
      method,
      headers: { "X-Api-Key": this.key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404 && method === "GET" && path === `/api/sessions/${SESSION}`) return null;
    if (!res.ok) {
      // WAHA's error text isn't shown: it can echo chat ids and message text.
      await res.body?.cancel().catch(() => {});
      const hint = res.status === 401 ? " Check the WAHA API key." : "";
      throw new Error(`WAHA answered ${res.status}.${hint}`);
    }
    if (raw) return Buffer.from(await res.arrayBuffer());
    return res.status === 204 ? null : res.json();
  }

  async status(): Promise<WaStatus> {
    const s = (await this.call("GET", `/api/sessions/${SESSION}`)) as { status: string; me?: { id?: string } | null } | null;
    if (!s) return { status: "MISSING", me: "" };
    return { status: s.status, me: (s.me?.id ?? "").replace(/@.*/, "") };
  }

  /**
   * Create the session if it's missing. A stopped or failed session is restarted only when it was linked
   * before (a dropped connection): an unlinked one stopped because nobody scanned its QR code in time,
   * and it waits for you to ask for a new code instead of showing codes nobody looks at.
   */
  async ensureSession(wasLinked: boolean): Promise<WaStatus> {
    const now = await this.status();
    if (now.status === "MISSING") return this.link();
    if ((now.status === "STOPPED" || now.status === "FAILED") && wasLinked) {
      await this.call("POST", `/api/sessions/${SESSION}/restart`);
      return this.status();
    }
    return now;
  }

  /**
   * Start linking: create the session, or restart it so WhatsApp shows a fresh QR code.
   * markOnline stays off, so your phone keeps getting notifications while the bridge is connected.
   */
  async link(): Promise<WaStatus> {
    const config = { noweb: { markOnline: false, store: { enabled: true, fullSync: false } } };
    const now = await this.status();
    if (now.status === "MISSING") await this.call("POST", "/api/sessions", { name: SESSION, start: true, config });
    else await this.call("POST", `/api/sessions/${SESSION}/restart`);
    return this.status();
  }

  /** The QR code to link the account, as a PNG. */
  async qr(): Promise<Buffer> {
    return (await this.call("GET", `/api/${SESSION}/auth/qr?format=image`, undefined, true)) as Buffer;
  }

  /** One page of chats, the most recently active first. */
  async chats(offset: number): Promise<ChatSummary[]> {
    return (await this.call("GET", `/api/${SESSION}/chats/overview?limit=${PAGE}&offset=${offset}`)) as ChatSummary[];
  }

  /** One page of a chat's messages since a time, oldest first. */
  async messagesSince(chatId: string, since: number, offset: number): Promise<WaMessage[]> {
    const q = `limit=${PAGE}&offset=${offset}&sortBy=timestamp&sortOrder=asc&downloadMedia=false&filter.timestamp.gte=${since}`;
    return (await this.call("GET", `/api/${SESSION}/chats/${encodeURIComponent(chatId)}/messages?${q}`)) as WaMessage[];
  }
}

const isGroup = (id: string) => id.endsWith("@g.us");
// Status updates and broadcast lists aren't conversations.
const skipChat = (id: string) => id === "status@broadcast" || id.endsWith("@broadcast");

export function toInbox(chat: ChatSummary, m: WaMessage, source = "whatsapp:1"): InboxInput {
  const group = isGroup(chat.id);
  const name = chat.name || chat.id.replace(/@.*/, "");
  const who = m.fromMe ? "You" : m._data?.verifiedBizName || m._data?.pushName || (group ? (m.participant ?? "").replace(/@.*/, "") : name) || name;
  let text = (m.body ?? "").trim();
  if (!text && m.hasMedia) text = "[media]";
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1).trimEnd() + "…";
  return {
    source,
    extId: m.id,
    thread: chat.id,
    threadName: name,
    sender: who,
    fromMe: m.fromMe,
    isGroup: group,
    // Channels (newsletters) and verified businesses are broadcasts, not people.
    automated: chat.id.endsWith("@newsletter") || Boolean(m._data?.verifiedBizName),
    subject: "",
    text,
    link: "",
    at: m.timestamp * 1000,
  };
}

/** A chat with more new messages than one run reads: where to go on. */
type Resume = Record<string, { name: string; since: number; offset: number }>;

/**
 * Read new messages since the last run, for WhatsApp number `slot`. Returns how many were new, or
 * the session's status when the number isn't linked (SCAN_QR_CODE, STARTING, FAILED, STOPPED).
 * `current` says whether the settings this run started with still hold; if not, nothing is saved.
 */
export async function readWhatsApp(
  waha: Waha,
  store: Store,
  slot = 1,
  current: () => boolean = () => true,
): Promise<{ added: number } | { waiting: string }> {
  const linkedKey = `whatsapp:slot${slot}:linked`;
  const session = await waha.ensureSession(Boolean(store.getState(linkedKey)));
  if (session.status !== "WORKING") return { waiting: session.status };
  if (current()) store.setState(linkedKey, session.me || "yes");
  const key = `whatsapp:${session.me}`;
  // WhatsApp timestamps are seconds. Messages read twice are skipped as duplicates.
  const cursor = Number(store.getState(key) ?? Math.floor((store.now() - FIRST_LOOK_BACK_MS) / 1000));
  const resume: Resume = JSON.parse(store.getState(`${key}:resume`) ?? "{}");
  // Messages can reach WAHA late (a phone that was offline), so each run looks 10 minutes behind the cursor.
  const since = cursor - 600;
  const started = Math.floor(store.now() / 1000);
  const found: InboxInput[] = [];
  const active = new Map<string, ChatSummary>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await waha.chats(offset);
    for (const c of page) if (!skipChat(c.id) && (c.lastMessage?.timestamp ?? 0) >= since) active.set(c.id, c);
    // Chats come newest first: once a page reaches back past the cursor, the rest are older still.
    if (page.length < PAGE || page.some((c) => (c.lastMessage?.timestamp ?? 0) < since)) break;
  }
  // A chat cut short last time goes on from where it stopped, with the same starting point.
  for (const [id, r] of Object.entries(resume)) if (!active.has(id)) active.set(id, { id, name: r.name });
  const next: Resume = {};
  const source = `whatsapp:${slot}`;
  for (const chat of active.values()) {
    const from = resume[chat.id]?.since ?? since;
    let offset = resume[chat.id]?.offset ?? 0;
    for (let p = 0; ; p++, offset += PAGE) {
      const page = await waha.messagesSince(chat.id, from, offset);
      for (const m of page) if (m.id && m.timestamp) found.push(toInbox(chat, m, source));
      if (page.length < PAGE) break;
      if (p + 1 >= MAX_PAGES) {
        next[chat.id] = { name: chat.name ?? "", since: from, offset: offset + PAGE };
        break;
      }
    }
  }
  if (!current()) return { added: 0 };
  const added = store.tx(() => {
    store.setState(`${key}:resume`, Object.keys(next).length ? JSON.stringify(next) : null);
    return store.addInbox(found, { key, value: String(Math.max(cursor, started)) });
  });
  return { added };
}
