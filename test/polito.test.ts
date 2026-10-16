import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { loadConfig, type Config } from "../server/config.ts";
import { Polito, POLITO_BOT, createPolitoSync, politoCard, type PolitoItem, type PolitoDeadline } from "../server/polito.ts";

const OWNER = "owner@example.com";
const clock = Date.parse("2026-10-13T09:00:00Z");
const config: Config = {
  host: "127.0.0.1", port: 0, dataDir: "", authMode: "tailscale", ownerLogin: OWNER, botToken: "test-token-123",
  todoistToken: "", todoistFilter: "", areadidatticaUrl: "http://areadidattica:8789", areadidatticaToken: "secret",
  undoSeconds: 5, archiveDays: 30, tz: "Europe/Rome", webhookAllowPrivate: false, backupDays: 0,
  publicDir: new URL("../public", import.meta.url).pathname.replace(/\/$/, ""),
};

const avviso = (id: number, text: string, extra: Partial<PolitoItem> = {}): PolitoItem => ({
  id: `notification:${id}`, kind: "avviso", course: "Analisi matematica II", title: "Nuovo avviso nel Corso di Analisi matematica II",
  text, sentAt: "2026-10-09T15:41:45+02:00", isRead: false, urgent: false, sourceUrl: null, ...extra,
});

/** A stand-in for areadidattica: unread items, deadlines, and the reads it was asked for. */
function fakeAreadidattica() {
  const fake = {
    unread: [] as PolitoItem[],
    deadlines: [] as PolitoDeadline[],
    reads: [] as string[],
    down: false,
    auth: [] as string[],
    fetch: null as unknown as typeof fetch,
    handle: (async (input: URL | RequestInfo, init?: RequestInit) => {
      const u = new URL(String(input));
      fake.auth.push(String(new Headers(init?.headers).get("authorization")));
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
      if (fake.down) return json({ error: "PoliTO login paused" }, 502);
      if (u.pathname === "/items" && u.searchParams.get("unread") === "true") return json({ items: fake.unread });
      if (u.pathname === "/deadlines") return json({ deadlines: fake.deadlines });
      const read = /^\/items\/([^/]+)\/read$/.exec(u.pathname);
      if (read && init?.method === "POST") {
        const id = decodeURIComponent(read[1]);
        fake.reads.push(id);
        fake.unread = fake.unread.filter((i) => i.id !== id);
        return json({ ok: true, id });
      }
      return json({ error: "not found" }, 404);
    }) as typeof fetch,
  };
  fake.fetch = fake.handle;
  return fake;
}

async function setup() {
  const fake = fakeAreadidattica();
  const store = new Store(":memory:", () => clock);
  const logs: string[] = [];
  // Through fake.fetch at call time, so a test can swap it.
  const polito = createPolitoSync(new Polito(config.areadidatticaUrl + "/", "secret", ((i, o) => fake.fetch(i, o)) as typeof fetch), store, config.tz, (m) => logs.push(m));
  const server = http.createServer(createApp({ config, store, polito, log: () => {} }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ui = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Tailscale-User-Login": OWNER, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const close = () => { server.closeAllConnections(); server.close(); store.close(); };
  return { fake, store, polito, ui, logs, close };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test("PoliTO: unread avvisi become cards in their own language, deadlines go on the agenda", async () => {
  const t = await setup();
  try {
    t.fake.unread = [
      avviso(1, "Gentili studenti,\n\nmercoledì 14 ottobre la lezione è spostata in aula 7T.\nA presto"),
      avviso(2, "", { id: "message:9", kind: "message", course: null, title: "Chiusura sedi", urgent: true }),
    ];
    t.fake.deadlines = [{ id: "deadline:a", title: "Pagamento seconda rata", date: "2026-10-14", course: null, type: "Tasse", url: null }];
    await t.polito.sync();
    const state = (await t.ui("GET", "/api/ui/state")).body;
    const a = state.catchup.find((c: { key: string }) => c.key === "notification:1");
    assert.equal(a.bot, POLITO_BOT);
    assert.equal(a.title, "mercoledì 14 ottobre la lezione è spostata in aula 7T.", "skips the greeting");
    assert.equal(a.body, "A presto", "doesn't repeat the title");
    assert.equal(a.source, "PoliTO · Analisi matematica II");
    assert.equal(a.app, "polito");
    assert.match(a.context, /^Avviso del 9 ottobre/);
    const m = state.needs.find((c: { key: string }) => c.key === "message:9");
    assert.equal(m.title, "Chiusura sedi", "no text: PoliTO's own title");
    assert.equal(m.urgent, "Emergenza");
    assert.deepEqual(state.agenda.map((e: { title: string; start: string; allDay: boolean }) => [e.title, e.start, e.allDay]), [["Pagamento seconda rata", "2026-10-14", true]]);
    assert.equal(state.bots.find((b: { slug: string }) => b.slug === POLITO_BOT).name, "PoliTO");
    assert.equal(state.polito.error, "");
    assert.deepEqual([state.needs.map((c: { key: string }) => c.key), state.catchup.map((c: { key: string }) => c.key)], [["message:9"], ["notification:1"]], "urgent notices need you, the rest read as catch-up");
    assert.ok(t.fake.auth.every((h) => h === "Bearer secret"));
  } finally {
    t.close();
  }
});

test("PoliTO: marking a card read or dismissing it marks it read on PoliTO, and it doesn't come back", async () => {
  const t = await setup();
  try {
    t.fake.unread = [avviso(1, "Uno"), avviso(2, "Due")];
    await t.polito.sync();
    const [one, two] = ["notification:1", "notification:2"].map((k) => t.store.getItemByKey(POLITO_BOT, k)!);
    const done = await t.ui("POST", `/api/ui/items/${one.id}/act`, { type: "done" });
    assert.equal(done.body.item.resolution, "Read");
    await t.ui("POST", `/api/ui/items/${two.id}/act`, { type: "dismiss" });
    await flush();
    assert.deepEqual(t.fake.reads, ["notification:1", "notification:2"]);
    await t.polito.sync();
    assert.equal(t.store.getItem(one.id)!.status, "closed");
    assert.equal(t.store.getItem(two.id)!.closedReason, "dismissed");
  } finally {
    t.close();
  }
});

test("PoliTO: a read that failed is retried by the next check", async () => {
  const t = await setup();
  try {
    t.fake.unread = [avviso(1, "Uno")];
    await t.polito.sync();
    const card = t.store.getItemByKey(POLITO_BOT, "notification:1")!;
    t.fake.down = true;
    await t.ui("POST", `/api/ui/items/${card.id}/act`, { type: "done" });
    await flush();
    assert.deepEqual(t.fake.reads, []);
    assert.ok(t.logs.some((l) => l.includes("marking notification:1 read failed")));
    t.fake.down = false;
    await t.polito.sync();
    assert.deepEqual(t.fake.reads, ["notification:1"]);
  } finally {
    t.close();
  }
});

test("PoliTO: avvisi read in the phone app close here, snoozed ones too", async () => {
  const t = await setup();
  try {
    t.fake.unread = [avviso(1, "Uno"), avviso(2, "Due"), avviso(3, "Tre")];
    await t.polito.sync();
    const snoozed = t.store.getItemByKey(POLITO_BOT, "notification:2")!;
    t.store.snoozeItem(snoozed.id, clock + 3600_000);
    t.fake.unread = [avviso(3, "Tre")];
    await t.polito.sync();
    for (const k of ["notification:1", "notification:2"]) {
      const c = t.store.getItemByKey(POLITO_BOT, k)!;
      assert.equal(c.status, "closed", k);
      assert.equal(c.resolution, "Read on PoliTO");
    }
    assert.equal(t.store.getItemByKey(POLITO_BOT, "notification:3")!.status, "open");
    assert.deepEqual(t.fake.reads, [], "nothing to mark read");
  } finally {
    t.close();
  }
});

test("PoliTO: an avviso missing from one check comes back unread, and is never marked read for you", async () => {
  const t = await setup();
  try {
    t.fake.unread = [avviso(1, "Uno")];
    await t.polito.sync();
    t.fake.unread = [];
    await t.polito.sync();
    const card = t.store.getItemByKey(POLITO_BOT, "notification:1")!;
    assert.equal(card.status, "closed");
    t.fake.unread = [avviso(1, "Uno")];
    await t.polito.sync();
    assert.equal(t.store.getItem(card.id)!.status, "open");
    assert.deepEqual(t.fake.reads, []);
  } finally {
    t.close();
  }
});

test("PoliTO: hundreds of cards read elsewhere all close", async () => {
  const t = await setup();
  try {
    t.fake.unread = Array.from({ length: 510 }, (_, i) => avviso(i + 1, `Avviso ${i + 1}`));
    await t.polito.sync();
    t.fake.unread = [];
    await t.polito.sync();
    assert.equal(t.store.liveItemsOf(POLITO_BOT).length, 0);
  } finally {
    t.close();
  }
});

test("PoliTO: a snoozed avviso still unread stays snoozed", async () => {
  const t = await setup();
  try {
    t.fake.unread = [avviso(1, "Uno")];
    await t.polito.sync();
    const card = t.store.getItemByKey(POLITO_BOT, "notification:1")!;
    t.store.snoozeItem(card.id, clock + 3600_000);
    await t.polito.sync();
    assert.equal(t.store.getItem(card.id)!.status, "snoozed");
  } finally {
    t.close();
  }
});

test("PoliTO: a slow mark-read retry doesn't hold up new avvisi", async () => {
  const t = await setup();
  try {
    t.fake.unread = [avviso(1, "Uno")];
    await t.polito.sync();
    const card = t.store.getItemByKey(POLITO_BOT, "notification:1")!;
    t.store.closeItem(card.id, "done", "Read");
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const fetchBefore = t.fake.fetch;
    t.fake.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") await held;
      return fetchBefore(input, init);
    }) as typeof fetch;
    t.fake.unread = [avviso(1, "Uno"), avviso(2, "Due")];
    const run = t.polito.sync();
    await flush();
    assert.equal(t.store.getItemByKey(POLITO_BOT, "notification:2")?.status, "open", "new card is in before the retry ends");
    release();
    await run;
    assert.deepEqual(t.fake.reads, ["notification:1"]);
  } finally {
    t.close();
  }
});

test("PoliTO: when areadidattica fails, cards stay, the page says why, and Refresh doesn't hang", async () => {
  const t = await setup();
  try {
    t.fake.unread = [avviso(1, "Uno")];
    await t.polito.sync();
    t.fake.down = true;
    await t.ui("POST", "/api/ui/refresh", {});
    await flush();
    const state = (await t.ui("GET", "/api/ui/state")).body;
    assert.match(state.polito.error, /areadidattica answered 502 .*PoliTO login paused/);
    assert.equal(state.catchup.length, 1);
    assert.equal(state.bots.find((b: { slug: string }) => b.slug === POLITO_BOT).refreshRequestedAt, null);
    t.fake.down = false;
    await t.polito.sync();
    assert.equal(t.polito.error(), "");
  } finally {
    t.close();
  }
});

test("PoliTO: cards take no answers, since no bot would receive them", async () => {
  const t = await setup();
  try {
    t.fake.unread = [avviso(1, "Uno")];
    await t.polito.sync();
    const card = t.store.getItemByKey(POLITO_BOT, "notification:1")!;
    const r = await t.ui("POST", `/api/ui/items/${card.id}/act`, { type: "write", text: "rispondi", rev: card.rev });
    assert.equal(r.status, 400);
    assert.equal(t.store.getItem(card.id)!.status, "open");
  } finally {
    t.close();
  }
});

test("PoliTO: overlapping checks share one run", async () => {
  const t = await setup();
  try {
    t.fake.unread = [avviso(1, "Uno")];
    await Promise.all([t.polito.sync(), t.polito.sync()]);
    assert.equal(t.fake.auth.length, 2, "one /items and one /deadlines call");
  } finally {
    t.close();
  }
});

test("PoliTO: a table keeps one row per line and never becomes the title", () => {
  const rows = ["MATRICOLA\tGiorno\tOra", ...Array.from({ length: 80 }, (_, i) => `${300000 + i}\tLunedì 14\t16:30`)].join("\n");
  const c = politoCard(avviso(1, `${rows}\n\nChi non può presentarsi mi scriva.`), "Europe/Rome");
  assert.equal(c.title, "Chi non può presentarsi mi scriva.");
  const intro = politoCard(avviso(2, `Buongiorno,\n\necco il calendario degli orali.\n\n${rows}`), "Europe/Rome");
  assert.equal(intro.title, "ecco il calendario degli orali.");
  assert.ok(intro.body!.startsWith("MATRICOLA\tGiorno\tOra\n300000\tLunedì 14\t16:30"));
  assert.ok(intro.body!.endsWith("300079\tLunedì 14\t16:30"), "all 80 rows, past a bot's 2000 characters");
});

test("PoliTO: long avvisi fit a card", () => {
  const c = politoCard(avviso(1, "x".repeat(150) + " fine\n" + "y".repeat(12_000)), "Europe/Rome");
  assert.ok(c.title.length <= 141 && c.title.endsWith("…"));
  assert.equal(c.body!.length, 10_000);
});

test("PoliTO turned off: Refresh doesn't wait on it forever", async () => {
  const store = new Store(":memory:", () => clock);
  store.updateBot(POLITO_BOT, { name: "PoliTO" });
  const server = http.createServer(createApp({ config: { ...config, areadidatticaUrl: "" }, store, log: () => {} }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ui/refresh`, {
      method: "POST", headers: { "Content-Type": "application/json", "Tailscale-User-Login": OWNER }, body: "{}",
    });
    assert.equal(res.status, 200);
    assert.equal(store.getBot(POLITO_BOT)!.refreshRequestedAt, null);
  } finally {
    server.closeAllConnections();
    server.close();
    store.close();
  }
});

test("config: AREADIDATTICA_URL needs a token and a real address", () => {
  const base = { OWNER_LOGIN: OWNER, BOT_TOKEN: "12345678", TZ: "Europe/Rome" };
  assert.throws(() => loadConfig({ ...base, AREADIDATTICA_URL: "http://areadidattica:8789" }), /AREADIDATTICA_TOKEN/);
  assert.throws(() => loadConfig({ ...base, AREADIDATTICA_URL: "areadidattica:8789", AREADIDATTICA_TOKEN: "x" }), /http/);
  assert.equal(loadConfig(base).areadidatticaUrl, "");
});
