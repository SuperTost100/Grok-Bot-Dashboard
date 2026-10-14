// Reads WhatsApp through WAHA (https://waha.devlike.pro), a bridge that links to your account as a
// device, like WhatsApp Web. The dashboard only reads: it never sends, marks read or changes a chat.
// It polls the chat list and fetches messages newer than the last run.

import type { InboxInput, Store } from "../store.ts";
import { FIRST_LOOK_BACK_MS } from "./mail.ts";

type Fetch = typeof fetch;

export const SESSION = "default";
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
      const detail = await res.text().then((t) => t.slice(0, 200), () => "");
      const hint = res.status === 401 ? " Check the WAHA API key." : "";
      throw new Error(`WAHA answered ${res.status} on ${method} ${path.split("?")[0]}${detail ? `: ${detail}` : ""}.${hint}`);
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
   * Create the session if it's missing and start it when it's stopped.
   * markOnline stays off, so your phone keeps getting notifications while the bridge is connected.
   */
  async ensureSession(): Promise<WaStatus> {
    const config = { noweb: { markOnline: false, store: { enabled: true, fullSync: false } } };
    const now = await this.status();
    if (now.status === "MISSING") await this.call("POST", "/api/sessions", { name: SESSION, start: true, config });
    else if (now.status === "STOPPED" || now.status === "FAILED") await this.call("POST", `/api/sessions/${SESSION}/start`);
    return now.status === "MISSING" ? this.status() : now;
  }

  /** The QR code to link the account, as a PNG. */
  async qr(): Promise<Buffer> {
    return (await this.call("GET", `/api/${SESSION}/auth/qr?format=image`, undefined, true)) as Buffer;
  }

  async chats(): Promise<ChatSummary[]> {
    return (await this.call("GET", `/api/${SESSION}/chats/overview?limit=100`)) as ChatSummary[];
  }

  async messagesSince(chatId: string, since: number): Promise<WaMessage[]> {
    const q = `limit=100&sortBy=timestamp&sortOrder=asc&downloadMedia=false&filter.timestamp.gte=${since}`;
    return (await this.call("GET", `/api/${SESSION}/chats/${encodeURIComponent(chatId)}/messages?${q}`)) as WaMessage[];
  }
}

const isGroup = (id: string) => id.endsWith("@g.us");
// Status updates and broadcast lists aren't conversations.
const skipChat = (id: string) => id === "status@broadcast" || id.endsWith("@broadcast");

export function toInbox(chat: ChatSummary, m: WaMessage): InboxInput {
  const group = isGroup(chat.id);
  const name = chat.name || chat.id.replace(/@.*/, "");
  const who = m.fromMe ? "You" : m._data?.verifiedBizName || m._data?.pushName || (group ? (m.participant ?? "").replace(/@.*/, "") : name) || name;
  let text = (m.body ?? "").trim();
  if (!text && m.hasMedia) text = "[media]";
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1).trimEnd() + "…";
  return {
    source: "whatsapp",
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

/** Read new messages since the last run. Returns how many were new, or null when the account isn't linked. */
export async function readWhatsApp(waha: Waha, store: Store): Promise<number | null> {
  const session = await waha.ensureSession();
  if (session.status !== "WORKING") return null;
  const key = `whatsapp:${session.me}`;
  // WhatsApp timestamps are seconds. Messages read twice are skipped as duplicates.
  const cursor = Number(store.getState(key) ?? Math.floor((store.now() - FIRST_LOOK_BACK_MS) / 1000));
  // Messages can reach WAHA late (a phone that was offline), so each run looks 10 minutes behind the cursor.
  const since = cursor - 600;
  let newest = cursor;
  const found: InboxInput[] = [];
  for (const chat of await waha.chats()) {
    const last = chat.lastMessage?.timestamp ?? 0;
    if (skipChat(chat.id) || last < since) continue;
    for (const m of await waha.messagesSince(chat.id, since)) {
      if (!m.id || !m.timestamp) continue;
      found.push(toInbox(chat, m));
      newest = Math.max(newest, m.timestamp);
    }
  }
  const added = store.addInbox(found);
  store.setState(key, String(newest));
  return added;
}
