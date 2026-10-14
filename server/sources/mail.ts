// Reads a mailbox over IMAP, read-only: the inbox for new mail and the Sent folder for your replies.
// It never sets flags, moves or deletes anything. New messages go to the inbox table for triage.

import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import type { InboxInput, Store } from "../store.ts";

export interface MailAccount {
  /** Settings slot, like 1. Part of the source name "mail:1". */
  slot: number;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
}

/** The first time a mailbox is read, it looks back this far. */
export const FIRST_LOOK_BACK_MS = 3 * 86_400_000;
const MAX_PER_RUN = 200;
const MAX_TEXT = 4000;

export function parseHost(raw: string): { host: string; port: number } | null {
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(raw.trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 993;
  return port > 0 && port < 65536 ? { host: m[1].toLowerCase(), port } : null;
}

/** Text without quoted replies and signatures' long tails, so triage reads what's new. */
export function cleanText(text: string): string {
  const lines: string[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    // "On Mon, 12 Oct 2026, Marco wrote:" and the Italian "Il giorno ... ha scritto:" start the quoted part.
    if (/^(on .{4,200} wrote:|il giorno .{4,200} ha scritto:|-----original message-----|-----messaggio originale-----)\s*$/i.test(line.trim())) break;
    if (/^\s*>/.test(line)) continue;
    lines.push(line);
  }
  const out = lines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length > MAX_TEXT ? out.slice(0, MAX_TEXT - 1).trimEnd() + "…" : out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ");
}

const subjectOnly = (s: string) => s.replace(/^\s*((re|r|fwd?|i|inoltra)\s*:\s*)+/i, "").trim();
const ids = (s: string | undefined) => (s ?? "").match(/<[^<>\s]+>/g) ?? [];

type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;

/** Turn one fetched message into an inbox row. */
export function toInbox(account: MailAccount, parsed: Parsed, uid: number, folder: "inbox" | "sent", fallbackDate: number): InboxInput {
  const header = (name: string) => parsed.headers.find((h) => h.key === name)?.value ?? "";
  const messageId = parsed.messageId || `<uid-${folder}-${uid}@${account.host}>`;
  // A thread is named after its first message, so replies (yours too) land in the same thread.
  const thread = ids(header("references"))[0] ?? ids(parsed.inReplyTo)[0] ?? messageId;
  const fromAddress = (parsed.from && "address" in parsed.from ? parsed.from.address : "") ?? "";
  const fromName = (parsed.from && "name" in parsed.from ? parsed.from.name : "") ?? "";
  const autoSubmitted = header("auto-submitted").toLowerCase();
  const automated =
    Boolean(header("list-unsubscribe") || header("list-id")) ||
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    /^(bulk|list|junk)$/i.test(header("precedence")) ||
    /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon)@/i.test(fromAddress);
  const date = parsed.date ? Date.parse(parsed.date) : NaN;
  const body = parsed.text || (parsed.html ? htmlToText(parsed.html) : "");
  const gmail = account.host === "imap.gmail.com";
  return {
    source: `mail:${account.slot}`,
    extId: `${folder}:${messageId}`,
    thread,
    threadName: subjectOnly(parsed.subject ?? "") || "(no subject)",
    sender: folder === "sent" ? "You" : fromName || fromAddress,
    fromMe: folder === "sent" || fromAddress.toLowerCase() === account.user.toLowerCase(),
    isGroup: false,
    automated: folder === "inbox" && automated,
    subject: (parsed.subject ?? "").slice(0, 300),
    text: cleanText(body),
    link: gmail && parsed.messageId ? `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(parsed.messageId.replace(/[<>]/g, ""))}` : "",
    at: Number.isFinite(date) ? date : fallbackDate,
  };
}

// Old servers like PoliTO's use Diffie-Hellman keys that OpenSSL now refuses by default.
// Those hosts get one retry with the older security level, remembered for the next runs.
const legacyHosts = new Set<string>();
const isWeakDh = (err: unknown) => /dh key too small|dh_key_too_small/i.test(String((err as Error)?.message ?? err));

async function connect(a: MailAccount): Promise<ImapFlow> {
  const open = async (legacy: boolean) => {
    const client = new ImapFlow({
      host: a.host,
      port: a.port,
      secure: true,
      auth: { user: a.user, pass: a.password },
      logger: false,
      socketTimeout: 60_000,
      tls: legacy ? { ciphers: "DEFAULT:@SECLEVEL=1" } : {},
    });
    // Errors after the connection is up arrive as events; without a listener they'd crash the server.
    client.on("error", () => {});
    await client.connect();
    return client;
  };
  if (legacyHosts.has(a.host)) return open(true);
  try {
    return await open(false);
  } catch (err) {
    if (!isWeakDh(err)) throw err;
    legacyHosts.add(a.host);
    return open(true);
  }
}

interface Cursor { uidValidity: string; lastUid: number }

/** Read one folder from where the last run stopped. */
async function readFolder(client: ImapFlow, a: MailAccount, path: string, folder: "inbox" | "sent", store: Store): Promise<InboxInput[]> {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const box = client.mailbox;
    if (!box) return [];
    const key = `mail:${a.slot}:${a.user}@${a.host}:${path}`;
    const saved = store.getState(key);
    let cursor: Cursor | null = saved ? JSON.parse(saved) : null;
    const validity = String(box.uidValidity);
    let uids: number[];
    if (!cursor || cursor.uidValidity !== validity) {
      // First run, or the server renumbered the folder: start from a few days back.
      uids = (await client.search({ since: new Date(store.now() - FIRST_LOOK_BACK_MS) }, { uid: true })) || [];
      // Everything up to now counts as read from here on, even in a folder with nothing recent.
      cursor = { uidValidity: validity, lastUid: Math.max(0, Number(box.uidNext ?? 1) - 1) };
    } else {
      uids = ((await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > cursor!.lastUid);
    }
    uids = uids.sort((x, y) => x - y).slice(-MAX_PER_RUN);
    const out: InboxInput[] = [];
    if (uids.length) {
      for await (const msg of client.fetch(uids, { uid: true, internalDate: true, source: { maxLength: 400_000 } }, { uid: true })) {
        if (!msg.source) continue;
        const parsed = await PostalMime.parse(msg.source);
        const internal = msg.internalDate ? new Date(msg.internalDate).getTime() : store.now();
        out.push(toInbox(a, parsed, msg.uid, folder, internal));
      }
    }
    const last = Math.max(cursor.lastUid, ...uids);
    store.setState(key, JSON.stringify({ uidValidity: validity, lastUid: last }));
    return out;
  } finally {
    lock.release();
  }
}

/** Read new mail and your new replies. Returns how many messages were new. */
export async function readMailbox(a: MailAccount, store: Store): Promise<number> {
  const client = await connect(a);
  try {
    const found = await readFolder(client, a, "INBOX", "inbox", store);
    const sent = (await client.list()).find((b) => b.specialUse === "\\Sent");
    if (sent) found.push(...(await readFolder(client, a, sent.path, "sent", store)));
    return store.addInbox(found);
  } finally {
    await client.logout().catch(() => client.close());
  }
}
