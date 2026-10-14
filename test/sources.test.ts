import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import PostalMime from "postal-mime";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { Settings } from "../server/settings.ts";
import { loadConfig } from "../server/config.ts";
import { cleanText, parseHost, readFolder, toInbox as mailToInbox } from "../server/sources/mail.ts";
import type { ImapFlow } from "imapflow";
import { Waha, readWhatsApp } from "../server/sources/whatsapp.ts";
import { eventsFromIcs, readCalendars, calendarUrls, CALENDAR_OWNER } from "../server/sources/calendar.ts";
import { createSources, plainError } from "../server/sources/index.ts";

const ICS = fs.readFileSync(new URL("./fixtures/calendar.ics", import.meta.url), "utf8");
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

// ---------- Mail ----------

const account = { slot: 2, name: "Gmail", host: "imap.gmail.com", port: 993, user: "me@gmail.com", password: "x" };
const mail = (headers: string, body: string) => PostalMime.parse(`${headers}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);

test("mail: a reply joins the thread of the first message and quoted text is dropped", async () => {
  const parsed = await mail(
    "From: Marco Rossi <marco@example.com>\r\nSubject: Re: Lab swap\r\nMessage-ID: <b@x>\r\nIn-Reply-To: <a@x>\r\nReferences: <a@x>\r\nDate: Mon, 12 Oct 2026 10:00:00 +0200",
    "Tuesday works for me.\r\n\r\nOn Mon, 12 Oct 2026 at 09:00, Tost wrote:\r\n> Can we swap?\r\n> Thanks",
  );
  const row = mailToInbox(account, parsed, 7, "inbox", 0);
  assert.equal(row.thread, "<a@x>");
  assert.equal(row.threadName, "Lab swap");
  assert.equal(row.sender, "Marco Rossi");
  assert.equal(row.text, "Tuesday works for me.");
  assert.equal(row.fromMe, false);
  assert.equal(row.automated, false);
  assert.equal(row.source, "mail:2");
  assert.equal(row.at, Date.parse("2026-10-12T08:00:00Z"));
  assert.match(row.link, /^https:\/\/mail\.google\.com\/.*rfc822msgid%3Ab%40x$/);
});

test("mail: newsletters and no-reply senders are marked automated; your sent mail is yours", async () => {
  const news = await mail("From: Shop <news@shop.example>\r\nSubject: Sale\r\nList-Unsubscribe: <mailto:u@shop.example>\r\nMessage-ID: <n@x>", "50% off");
  assert.equal(mailToInbox(account, news, 1, "inbox", 0).automated, true);
  const bot = await mail("From: no-reply@service.example\r\nSubject: Code\r\nMessage-ID: <c@x>", "123456");
  assert.equal(mailToInbox(account, bot, 2, "inbox", 0).automated, true);
  const sent = await mail("From: me@gmail.com\r\nTo: marco@example.com\r\nSubject: Re: Lab swap\r\nMessage-ID: <s@x>\r\nReferences: <a@x> <b@x>", "Deal");
  const row = mailToInbox(account, sent, 3, "sent", 0);
  assert.deepEqual([row.fromMe, row.sender, row.thread, row.automated], [true, "You", "<a@x>", false]);
});

test("mail: long text is cut and host:port parsed", () => {
  assert.equal(cleanText("x".repeat(5000)).length, 4000);
  assert.deepEqual(parseHost("imap.example.com"), { host: "imap.example.com", port: 993 });
  assert.deepEqual(parseHost("IMAP.example.com:143"), { host: "imap.example.com", port: 143 });
  assert.equal(parseHost("https://imap.example.com"), null);
});

// ---------- WhatsApp ----------

function fakeWaha() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let status = "MISSING";
  const now = Math.floor(Date.parse("2026-10-12T11:00:00Z") / 1000);
  const messages: Record<string, unknown[]> = {
    "120363@g.us": [
      { id: "g1", timestamp: now - 60, fromMe: false, participant: "39340@c.us", body: "Who's free on Tuesday?", _data: { pushName: "Marco" } },
      { id: "g2", timestamp: now - 30, fromMe: true, body: "Me" },
    ],
    "39333@c.us": [{ id: "d1", timestamp: now - 10, fromMe: false, body: "", hasMedia: true, _data: { pushName: "Anna" } }],
    "status@broadcast": [{ id: "s1", timestamp: now, fromMe: false, body: "story" }],
  };
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    assert.equal(new Headers(init?.headers).get("x-api-key"), "wkey");
    if (u.pathname === "/api/sessions/default") return status === "MISSING" ? json({ error: "not found" }, 404) : json({ status, me: status === "WORKING" ? { id: "39340000@c.us" } : null });
    if (u.pathname === "/api/sessions" && method === "POST") { status = "SCAN_QR_CODE"; return json({ status }); }
    if (u.pathname === "/api/default/chats/overview") {
      return json([
        { id: "120363@g.us", name: "Lab group", lastMessage: { timestamp: now - 30 } },
        { id: "39333@c.us", name: "Anna", lastMessage: { timestamp: now - 10 } },
        { id: "status@broadcast", name: null, lastMessage: { timestamp: now } },
        { id: "39999@c.us", name: "Old chat", lastMessage: { timestamp: now - 30 * 86400 } },
      ]);
    }
    const m = /^\/api\/default\/chats\/([^/]+)\/messages$/.exec(u.pathname);
    if (m) {
      const since = Number(u.searchParams.get("filter.timestamp.gte"));
      return json((messages[decodeURIComponent(m[1])] ?? []).filter((x) => (x as { timestamp: number }).timestamp >= since));
    }
    return json({ error: "unexpected" }, 500);
  }) as typeof fetch;
  return { waha: new Waha("http://waha:3000/", "wkey", fetchImpl), calls, link: () => { status = "WORKING"; } };
}

test("whatsapp: an unlinked account gets a session with markOnline off and reads nothing", async () => {
  const f = fakeWaha();
  const store = new Store(":memory:", () => Date.parse("2026-10-12T11:00:00Z"));
  assert.equal(await readWhatsApp(f.waha, store), null);
  const created = f.calls.find((c) => c.path === "/api/sessions")!;
  assert.deepEqual(created.body, { name: "default", start: true, config: { noweb: { markOnline: false, store: { enabled: true, fullSync: false } } } });
  assert.ok(!f.calls.some((c) => c.path.includes("/chats")));
});

test("whatsapp: a linked account reads new messages once, skipping status updates", async () => {
  const f = fakeWaha();
  f.link();
  const store = new Store(":memory:", () => Date.parse("2026-10-12T11:00:00Z"));
  assert.equal(await readWhatsApp(f.waha, store), 3);
  const rows = store.untriaged();
  assert.deepEqual(rows.map((r) => [r.thread, r.threadName, r.sender, r.fromMe, r.isGroup, r.text]), [
    ["120363@g.us", "Lab group", "Marco", false, true, "Who's free on Tuesday?"],
    ["120363@g.us", "Lab group", "You", true, true, "Me"],
    ["39333@c.us", "Anna", "Anna", false, false, "[media]"],
  ]);
  assert.ok(!f.calls.some((c) => c.path.includes("39999")), "a chat with nothing new isn't opened");
  assert.equal(await readWhatsApp(f.waha, store), 0, "the second run finds nothing new");
  assert.ok(!f.calls.some((c) => c.method !== "GET" && c.path.includes("/chats")), "nothing is ever marked read or sent");
});

// ---------- Calendar ----------

test("calendar: recurring events, exceptions, all-day and cancelled events land on the right days", () => {
  const { events } = eventsFromIcs(ICS, "2026-10-12", "2026-10-14", "Europe/Rome", "googlecalendar");
  assert.deepEqual(events.map((e) => [e.title, e.start, e.end, e.allDay]), [
    ["Trip to Biella", "2026-10-11", "2026-10-13", true],
    ["Analisi II (moved)", "2026-10-12T14:00:00", "2026-10-12T15:30:00", false],
    ["Dentist", "2026-10-12T17:15:00", "2026-10-12T18:00:00", false],
    ["Day off", "2026-10-13", "", true],
  ]);
  const later = eventsFromIcs(ICS, "2026-10-14", "2026-10-16", "Europe/Rome", "").events;
  assert.deepEqual(later.map((e) => [e.title, e.start, e.location]), [["Analisi II", "2026-10-14T08:30:00", "Aula 7"]]);
});

test("calendar: errors never show the secret address", async () => {
  const urls = calendarUrls("webcal://calendar.google.com/secret-abc  https://example.com/b.ics ftp://nope");
  assert.deepEqual(urls, ["https://calendar.google.com/secret-abc", "https://example.com/b.ics"]);
  const missing = (async () => new Response("gone", { status: 404 })) as typeof fetch;
  await assert.rejects(readCalendars(urls, Date.now(), "Europe/Rome", missing), (err: Error) => /Calendar 1 answered 404/.test(err.message) && !err.message.includes("secret-abc"));
  const html = (async () => new Response("<html>login</html>")) as typeof fetch;
  await assert.rejects(readCalendars(urls, Date.now(), "Europe/Rome", html), /isn't an iCal file/);
});

// ---------- On the page ----------

test("with iCal addresses set, the agenda shows the calendar and PoliTO, not what bots send", async () => {
  const clock = Date.parse("2026-10-12T08:00:00Z");
  const env = { OWNER_LOGIN: "o@x.com", BOT_TOKEN: "test-token-123", TZ: "Europe/Rome" };
  const config = { ...loadConfig(env), publicDir: new URL("../public", import.meta.url).pathname.replace(/\/$/, "") };
  const store = new Store(":memory:", () => clock);
  const settings = new Settings(store, config, env);
  const sources = createSources(settings, store, config.tz, () => {});
  const server = http.createServer(createApp({ config, store, settings, sources, log: () => {} }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => (await fetch(base + path, { headers: { "Tailscale-User-Login": "o@x.com" } })).json();
  try {
    store.replaceEvents("dashboard", "2026-10-12", "2026-10-14", [{ title: "From the bot", start: "2026-10-12T09:00:00", end: "", location: "", allDay: false, app: "" }]);
    store.replaceEvents(CALENDAR_OWNER, "2026-10-12", "2026-10-14", [{ title: "From iCal", start: "2026-10-12T10:00:00", end: "", location: "", allDay: false, app: "" }], false);
    store.replaceEvents("polito", "2026-10-12", "2026-11-12", [{ title: "Exam signup closes", start: "2026-10-12", end: "", location: "", allDay: true, app: "polito" }]);
    const titles = async () => (await get("/api/ui/state")).agenda.map((e: { title: string }) => e.title);
    assert.deepEqual(await titles(), ["Exam signup closes", "From the bot"], "calendar off: bots' agenda");
    settings.update({ calendarUrls: "https://calendar.google.com/x.ics" });
    assert.deepEqual(await titles(), ["Exam signup closes", "From iCal"], "calendar on: iCal and PoliTO");
    assert.ok(!(await get("/api/ui/state")).bots.some((b: { slug: string }) => b.slug === CALENDAR_OWNER), "the calendar gets no bot chip");

    const view = await get("/api/ui/settings");
    assert.deepEqual(view.status.find((x: { group: string }) => x.group === "Mail 1"), { group: "Mail 1", on: false, ok: true, text: "Off" });
    assert.equal(view.status.find((x: { group: string }) => x.group === "Calendar").text, "Connecting…");
    assert.equal((await fetch(base + "/api/ui/whatsapp/qr", { headers: { "Tailscale-User-Login": "o@x.com" } })).status, 404, "no QR while WhatsApp is off");
  } finally {
    server.closeAllConnections();
    server.close();
    store.close();
  }
});

test("a mailbox with a bad server name says so on Settings, and the banner waits 10 minutes", async () => {
  let clock = Date.parse("2026-10-12T08:00:00Z");
  const env = { OWNER_LOGIN: "o@x.com", BOT_TOKEN: "test-token-123", TZ: "Europe/Rome" };
  const config = loadConfig(env);
  const store = new Store(":memory:", () => clock);
  const settings = new Settings(store, config, env);
  const sources = createSources(settings, store, config.tz, () => {});
  settings.update({ mail1Host: "https://wrong", mail1User: "me", mail1Password: "pw" });
  await sources.refresh();
  const st = sources.status().find((x) => x.group === "Mail 1")!;
  assert.deepEqual([st.on, st.ok], [true, false]);
  assert.match(st.text, /must look like imap\.example\.com/);
  assert.deepEqual(sources.problems(), []);
  clock += 11 * 60_000;
  assert.match(sources.problems()[0], /^Mail 1 can't be read/);
  store.close();
});

test("source errors read as sentences", () => {
  assert.equal(plainError(Object.assign(new Error("getaddrinfo ENOTFOUND imap.x"), { code: "ENOTFOUND", hostname: "imap.x" })), "Can't find the server imap.x. Check its name.");
  assert.equal(plainError(Object.assign(new Error("Command failed"), { authenticationFailed: true })), "The server refused the login or password.");
  assert.equal(plainError(new TypeError("fetch failed")), "Couldn't connect. Check the address.");
  assert.equal(plainError(new Error("Calendar 1 answered 404")), "Calendar 1 answered 404");
  assert.equal(plainError(new Error("bad https://calendar.google.com/secret/basic.ics here")), "bad [address] here");
});

// ---------- Review fixes ----------

const VCAL = (body: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...body.trim().split("\n").map((l) => l.trim()), "END:VCALENDAR"].join("\r\n");

test("calendar: an occurrence moved into today from a later week shows today, once", () => {
  const ics = VCAL(`
    BEGIN:VEVENT
    UID:w@x
    SUMMARY:Weekly
    DTSTART:20261007T080000Z
    DTEND:20261007T090000Z
    RRULE:FREQ=WEEKLY
    END:VEVENT
    BEGIN:VEVENT
    UID:w@x
    RECURRENCE-ID:20261021T080000Z
    SUMMARY:Weekly (moved up)
    DTSTART:20261014T150000Z
    DTEND:20261014T160000Z
    END:VEVENT`);
  const { events } = eventsFromIcs(ics, "2026-10-14", "2026-10-16", "Europe/Rome", "");
  assert.deepEqual(events.map((e) => [e.title, e.start]), [["Weekly", "2026-10-14T10:00:00"], ["Weekly (moved up)", "2026-10-14T17:00:00"]]);
  const week = eventsFromIcs(ics, "2026-10-21", "2026-10-23", "Europe/Rome", "").events;
  assert.deepEqual(week, [], "its original date is empty");
});

test("calendar: a daily series that began years ago still shows, and one too long to expand is counted", () => {
  const old = VCAL(`
    BEGIN:VEVENT
    UID:d@x
    SUMMARY:Since 2010
    DTSTART:20100101T080000Z
    DTEND:20100101T083000Z
    RRULE:FREQ=DAILY
    END:VEVENT`);
  assert.deepEqual(eventsFromIcs(old, "2026-10-14", "2026-10-15", "Europe/Rome", "").events.map((e) => e.start), ["2026-10-14T10:00:00"]);
  const minutely = VCAL(`
    BEGIN:VEVENT
    UID:m@x
    SUMMARY:Every minute
    DTSTART:20200101T000000Z
    DTEND:20200101T000100Z
    RRULE:FREQ=MINUTELY
    END:VEVENT`);
  assert.equal(eventsFromIcs(minutely, "2026-10-14", "2026-10-15", "Europe/Rome", "").skipped, 1);
});

test("calendar: a network error never quotes the secret address", async () => {
  const leaky = (async (input: URL | RequestInfo) => { throw new TypeError(`fetch failed for ${String(input)}`); }) as typeof fetch;
  await assert.rejects(
    readCalendars(["https://calendar.google.com/private-token/basic.ics"], Date.now(), "Europe/Rome", leaky),
    (err: Error) => err.message === "Calendar 1 couldn't be reached. Check its address." && !err.message.includes("private-token"),
  );
  assert.deepEqual(calendarUrls("https://example.com:99999/x.ics"), [], "an address that doesn't parse is dropped");
});

/** A pretend IMAP folder with these UIDs, enough for readFolder. */
function fakeImap(uids: number[], uidNext: number) {
  const fetched: number[][] = [];
  const raw = (uid: number) => Buffer.from(`From: a@x\r\nSubject: m${uid}\r\nMessage-ID: <m${uid}@x>\r\nDate: Mon, 12 Oct 2026 10:00:00 +0200\r\n\r\nhi ${uid}`);
  const client = {
    mailbox: { uidValidity: 7n, uidNext },
    async getMailboxLock() { return { release() {} }; },
    async search(q: { uid?: string }) {
      if (!q.uid) return uids;
      const from = Number(q.uid.split(":")[0]);
      // Like a real server, "n:*" returns the newest message even when it's below n.
      const hits = uids.filter((u) => u >= from);
      return hits.length ? hits : uids.slice(-1);
    },
    async *fetch(list: number[]) {
      fetched.push(list);
      for (const uid of list) yield { uid, source: raw(uid), internalDate: new Date() };
    },
  };
  return { client: client as unknown as ImapFlow, fetched };
}

test("mail: a backlog over 200 messages is read oldest first across runs, none lost", async () => {
  const store = new Store(":memory:");
  const all = Array.from({ length: 350 }, (_, i) => i + 1);
  const { client, fetched } = fakeImap(all, 351);
  assert.equal(await readFolder(client, account, "INBOX", "inbox", store), 200);
  assert.deepEqual([fetched[0][0], fetched[0].at(-1)], [1, 200]);
  assert.equal(await readFolder(client, account, "INBOX", "inbox", store), 150);
  assert.equal(await readFolder(client, account, "INBOX", "inbox", store), 0, "the newest message isn't read twice");
  assert.equal(store.untriaged(1000).length, 350);
});

test("mail: when storing fails, the cursor stays where it was", async () => {
  const store = new Store(":memory:");
  const { client } = fakeImap([5, 6], 7);
  const add = store.addInbox.bind(store);
  store.addInbox = () => { throw new Error("disk full"); };
  await assert.rejects(readFolder(client, account, "INBOX", "inbox", store), /disk full/);
  store.addInbox = add;
  assert.equal(await readFolder(client, account, "INBOX", "inbox", store), 2, "the next run gets both messages");
});

test("whatsapp: long chats are paged, and the cursor waits for a chat cut short", async () => {
  const now = Math.floor(Date.parse("2026-10-12T11:00:00Z") / 1000);
  const big = Array.from({ length: 1150 }, (_, i) => ({ id: `b${i}`, timestamp: now - 3000 + i, fromMe: false, body: `m${i}` }));
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const u = new URL(String(input));
    if (u.pathname === "/api/sessions/default") return json({ status: "WORKING", me: { id: "1@c.us" } });
    if (u.pathname === "/api/default/chats/overview") {
      const off = Number(u.searchParams.get("offset"));
      // 150 chats: 149 quiet ones after the busy one, so the list needs two pages.
      const chats = [{ id: "big@g.us", name: "Busy", lastMessage: { timestamp: now } }, ...Array.from({ length: 149 }, (_, i) => ({ id: `q${i}@c.us`, name: `Q${i}`, lastMessage: { timestamp: now - 5 } }))];
      return json(chats.slice(off, off + 100));
    }
    if (u.pathname.includes("/messages")) {
      const off = Number(u.searchParams.get("offset"));
      const since = Number(u.searchParams.get("filter.timestamp.gte"));
      const list = u.pathname.includes("big") ? big.filter((m) => m.timestamp >= since) : [];
      return json(list.slice(off, off + 100));
    }
    return json({}, 500);
  }) as typeof fetch;
  const store = new Store(":memory:", () => now * 1000);
  const waha = new Waha("http://waha:3000", "k", fetchImpl);
  assert.equal(await readWhatsApp(waha, store), 1000, "10 pages per run");
  assert.ok(Number(store.getState("whatsapp:1")) < now, "the cursor stops where the busy chat was cut");
  assert.equal(await readWhatsApp(waha, store), 150, "the next run gets the rest");
});

test("a calendar whose address changes mid-run doesn't overwrite the new agenda", async () => {
  const env = { OWNER_LOGIN: "o@x.com", BOT_TOKEN: "test-token-123", TZ: "Europe/Rome" };
  const config = loadConfig(env);
  const store = new Store(":memory:");
  const settings = new Settings(store, config, env);
  const sources = createSources(settings, store, config.tz, () => {});
  settings.update({ calendarUrls: "https://a.example/one.ics" });
  // Nothing answers: the run is still going when the address changes.
  const realFetch = globalThis.fetch;
  let release: () => void = () => {};
  globalThis.fetch = (async () => {
    await new Promise<void>((r) => { release = r; });
    return new Response(VCAL(`BEGIN:VEVENT\nUID:o@x\nSUMMARY:Old\nDTSTART:${new Date().toISOString().slice(0, 10).replace(/-/g, "")}T100000Z\nEND:VEVENT`));
  }) as typeof fetch;
  try {
    const first = sources.refresh();
    settings.update({ calendarUrls: "https://b.example/two.ics" });
    void sources.refresh();
    release();
    await first;
    assert.equal(store.listEvents("2000-01-01", "2100-01-01").length, 0, "the old address's events were dropped");
  } finally {
    globalThis.fetch = realFetch;
    store.close();
  }
});
