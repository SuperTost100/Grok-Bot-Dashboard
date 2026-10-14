import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Store, type InboxInput, type InboxMessage } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { Settings } from "../server/settings.ts";
import { loadConfig } from "../server/config.ts";
import { createTriage, decide, routeFor, type Decision } from "../server/triage.ts";
import type { JevResult } from "../server/jev.ts";

const TZ = "Europe/Rome";
const env = { OWNER_LOGIN: "o@x.com", BOT_TOKEN: "test-token-123", TZ };

// ---------- Decisions ----------

function answers(level: number, need: string, opts: { whenConf?: number; needConf?: number; probs?: Record<string, number>; auto?: number } = {}): JevResult["answers"] {
  return {
    when: { type: "score", score: level, confidence: opts.whenConf ?? 0.9 },
    need: { type: "choice", choice: need, confidence: opts.needConf ?? 0.9, probabilities: opts.probs ?? { [need]: 0.9 } },
    automated: { type: "noul", noul: opts.auto ?? 0.1 },
  };
}

test("a sure answer is taken as it is", () => {
  const d = decide(answers(2.4, "info"), 60, false);
  assert.deepEqual([d.level, d.need, d.actionable, d.unsure], [2, "info", false, false]);
});

test("when Jev is unsure, the message counts as more urgent and as needing a reply if one is likely", () => {
  const d = decide(answers(2.3, "info", { whenConf: 0.4, needConf: 0.4, probs: { info: 0.5, reply: 0.4, decision: 0.1 } }), 60, false);
  assert.deepEqual([d.level, d.need, d.actionable, d.unsure], [3, "reply", true, true]);
});

test("routes follow the table", () => {
  const r = (level: number, need: Decision["need"], actionable = false, automated = false) => routeFor({ level, need, actionable, automated, unsure: false });
  assert.equal(r(4, "reply", true), "wake");
  assert.equal(r(3, "decision", true), "ride");
  assert.equal(r(1, "reply", true), "ride");
  assert.equal(r(2, "task"), "card");
  assert.equal(r(1, "task"), "catchup");
  assert.equal(r(3, "info"), "card");
  assert.equal(r(4, "info", false, true), "card", "an urgent automatic alert still gets a card");
  assert.equal(r(2, "info"), "catchup");
  assert.equal(r(2, "info", false, true), "skip");
  assert.equal(r(0, "info"), "skip");
  assert.equal(r(3, "nothing"), "card", "today beats nothing");
  assert.equal(r(1, "nothing"), "skip");
});

// ---------- The loop, with a pretend Jev ----------

async function setup(opts: { reply?: (state: Record<string, unknown>) => JevResult["answers"] } = {}) {
  let clock = Date.parse("2026-10-12T10:00:00Z");
  const config = { ...loadConfig(env), publicDir: new URL("../public", import.meta.url).pathname.replace(/\/$/, "") };
  const store = new Store(":memory:", () => clock);
  const settings = new Settings(store, config, env);
  const jevCalls: Record<string, unknown>[] = [];
  const pings: { url: string; body: string; headers: Headers }[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      const body = JSON.parse(String(init?.body));
      jevCalls.push(body.state);
      const a = opts.reply ? opts.reply(body.state) : answers(2, "info");
      return new Response(JSON.stringify({ model: "typesafe/jev-1.13-x", answers: a, usage: { cost: 0.00002 } }));
    }
    pings.push({ url, body: String(init?.body), headers: new Headers(init?.headers) });
    return new Response("{}");
  }) as typeof fetch;
  const triage = createTriage({
    store, settings, tz: TZ, log: () => {}, fetch: fetchImpl,
    sourceInfo: (m: InboxMessage) => ({ label: `WhatsApp · ${m.threadName}`, app: "whatsapp", where: `WhatsApp chat with ${m.threadName}` }),
  });
  settings.update({ openrouterKey: "sk-or-test", triageMode: "on", ntfyTopic: "secret-topic", dashboardUrl: "https://dash.example" });
  const notified: string[] = [];
  const server = http.createServer(createApp({ config, store, settings, triage, log: () => {}, notify: (b, r) => notified.push(`${b}:${r}`) }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  const msg = (thread: string, text: string, extra: Partial<InboxInput> = {}): InboxInput => ({
    source: "whatsapp", extId: `m${++n}`, thread, threadName: thread.replace(/@.*/, ""), sender: "Marco", fromMe: false, isGroup: false,
    automated: false, subject: "", text, link: "", at: clock - 120_000, ...extra,
  });
  const bot = async (path: string) => (await fetch(base + path, { headers: { Authorization: "Bearer test-token-123", "X-Bot": "dashboard" } })).json();
  const ui = async (method: string, path: string, body?: unknown) =>
    (await fetch(base + path, { method, headers: { "Tailscale-User-Login": "o@x.com", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
  return {
    store, settings, triage, jevCalls, pings, notified, msg, bot, ui,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    stop: () => { server.closeAllConnections(); server.close(); store.close(); },
  };
}

test("a reply needed now: urgent card, one ping without content, Grok woken and handed the chat", async () => {
  const t = await setup({ reply: () => answers(4, "reply") });
  try {
    t.store.addInbox([t.msg("393401234567@c.us", "Are you coming to the lab at 11? I need the key"), t.msg("393401234567@c.us", "Please answer")]);
    await t.triage.tick();
    const card = t.store.getItemByKey("dashboard", "inbox:whatsapp:393401234567@c.us:needs")!;
    assert.equal(card.urgent, "Reply soon");
    assert.equal(card.title, "Marco: Please answer");
    assert.equal(card.link, "https://wa.me/393401234567");
    assert.equal(t.jevCalls.length, 1, "one decision for the whole burst");
    assert.equal((t.jevCalls[0].new_messages as unknown[]).length, 2);
    assert.equal(t.store.getBot("dashboard")!.lastSeenAt, null, "the server's card doesn't count as the bot checking in");

    assert.equal(t.pings.length, 1);
    assert.equal(t.pings[0].url, "https://ntfy.sh/secret-topic");
    assert.equal(t.pings[0].body, "1 urgent card on your dashboard");
    assert.equal(t.pings[0].headers.get("click"), "https://dash.example");

    assert.equal(t.triage.wakeDue(), true);
    t.triage.woke();
    assert.equal(t.triage.wakeDue(), false, "one attempt per cooldown");
    const actions = await t.bot("/api/bot/actions");
    assert.equal(actions.inbox.length, 1);
    assert.equal(actions.inbox[0].key, "inbox:whatsapp:393401234567@c.us:needs");
    assert.deepEqual(actions.inbox[0].messages.map((m: { text: string; isNew: boolean }) => [m.text, m.isNew]), [
      ["Are you coming to the lab at 11? I need the key", true], ["Please answer", true],
    ]);
    assert.equal((await t.bot("/api/bot/actions")).inbox.length, 0, "handed out once");
  } finally {
    t.stop();
  }
});

test("a chat that's still typing waits; a burst is one decision", async () => {
  const t = await setup();
  try {
    t.store.addInbox([t.msg("1@c.us", "hey", { at: t.now() - 10_000 })]);
    await t.triage.tick();
    assert.equal(t.jevCalls.length, 0, "under a minute of quiet: wait");
    t.advance(60_000);
    await t.triage.tick();
    assert.equal(t.jevCalls.length, 1);
  } finally {
    t.stop();
  }
});

test("non-urgent replies wait for a batch of 3, or for 2 hours", async () => {
  const t = await setup({ reply: () => answers(3, "reply") });
  try {
    t.store.addInbox([t.msg("1@c.us", "a"), t.msg("2@c.us", "b")]);
    await t.triage.tick();
    assert.equal(t.triage.wakeDue(), false, "2 waiting");
    t.store.addInbox([t.msg("3@c.us", "c")]);
    await t.triage.tick();
    assert.equal(t.triage.wakeDue(), true, "3 waiting");
  } finally {
    t.stop();
  }
  const u = await setup({ reply: () => answers(3, "reply") });
  try {
    u.store.addInbox([u.msg("1@c.us", "a")]);
    await u.triage.tick();
    assert.equal(u.triage.wakeDue(), false);
    u.advance(2 * 3_600_000);
    assert.equal(u.triage.wakeDue(), true, "the oldest waited 2 hours");
  } finally {
    u.stop();
  }
});

test("the cooldown and the daily ceiling hold Grok back, and taps count as runs", async () => {
  const t = await setup({ reply: () => answers(4, "reply") });
  try {
    t.store.addWake("actions"); // a tap woke Grok a minute ago
    t.store.addInbox([t.msg("1@c.us", "now!")]);
    await t.triage.tick();
    assert.equal(t.triage.wakeDue(), false, "Grok ran under 45 minutes ago");
    t.advance(46 * 60_000);
    assert.equal(t.triage.wakeDue(), true);
    t.settings.update({ wakeCeiling: 1 });
    assert.equal(t.triage.wakeDue(), false, "1 run today already");
    assert.equal(t.triage.runsToday(), 1);
    assert.equal((await t.ui("GET", "/api/ui/state")).grokRunsToday, 1);
  } finally {
    t.stop();
  }
});

test("info becomes a card or a catch-up line without Grok; noise is filtered and listed", async () => {
  const levels: Record<string, JevResult["answers"]> = {
    "info@c.us": answers(3, "info"),
    "group@g.us": answers(1.8, "info"),
    "shop@c.us": answers(1, "info", { auto: 0.95 }),
  };
  const t = await setup({ reply: (state) => levels[String(state.where).replace("WhatsApp chat with ", "") + (String(state.where).includes("group") ? "@g.us" : "@c.us")] ?? answers(1, "info", { auto: 0.95 }) });
  try {
    t.store.addInbox([
      t.msg("info@c.us", "The exam room changed to 7I"),
      t.msg("group@g.us", "lol", { isGroup: true, threadName: "group" }),
      t.msg("group@g.us", "see you", { isGroup: true, sender: "Anna", threadName: "group" }),
      t.msg("shop@c.us", "50% off everything", { automated: true }),
    ]);
    await t.triage.tick();
    const info = t.store.getItemByKey("dashboard", "inbox:whatsapp:info@c.us:needs")!;
    assert.deepEqual([info.section, info.kind, info.urgent], ["needs", "reminder", ""]);
    const digest = t.store.getItemByKey("dashboard", "inbox:whatsapp:group@g.us:digest")!;
    assert.deepEqual([digest.section, digest.countLabel], ["catchup", "2 messages"]);
    assert.match(digest.body, /Anna: see you/);
    const skipped = t.store.listItems({ section: "catchup" }).find((i) => i.key?.startsWith("inbox:skipped:"))!;
    assert.equal(skipped.title, "Filtered out today");
    assert.match(skipped.body, /50% off everything/);
    assert.equal(t.store.grokQueue().length, 0, "nothing here needs Grok");
    assert.equal(t.pings.length, 0);
  } finally {
    t.stop();
  }
});

test("when you reply from your phone, the chat's card closes and Grok isn't needed", async () => {
  const t = await setup({ reply: () => answers(3, "reply") });
  try {
    t.store.addInbox([t.msg("1@c.us", "Can you send me the notes?")]);
    await t.triage.tick();
    assert.equal(t.store.grokQueue().length, 1);
    t.store.addInbox([t.msg("1@c.us", "Sure, here", { fromMe: true, sender: "You", at: t.now() })]);
    await t.triage.tick();
    const card = t.store.getItemByKey("dashboard", "inbox:whatsapp:1@c.us:needs")!;
    assert.deepEqual([card.status, card.resolution], ["closed", "You replied on WhatsApp"]);
    assert.equal(t.store.grokQueue().length, 0);
    assert.equal(t.jevCalls.length, 1, "your own message costs no decision");
  } finally {
    t.stop();
  }
});

test("news in a chat keeps the draft Grok wrote, and goes back to Grok", async () => {
  const t = await setup({ reply: () => answers(3, "info") });
  try {
    t.store.upsertItem({ bot: "dashboard", key: "inbox:whatsapp:1@c.us:needs", section: "needs", kind: "draft", title: "Reply to Marco", draft: { to: "Marco", text: "Yes, 11 works" } });
    t.store.addInbox([t.msg("1@c.us", "Also bring the cable")]);
    await t.triage.tick();
    const card = t.store.getItemByKey("dashboard", "inbox:whatsapp:1@c.us:needs")!;
    assert.equal(card.kind, "draft");
    assert.equal(card.draft!.text, "Yes, 11 works");
    assert.equal(t.store.grokQueue().length, 1);
  } finally {
    t.stop();
  }
});

test("messages from before triage was on are filed without a decision", async () => {
  const t = await setup();
  try {
    t.store.addInbox([t.msg("1@c.us", "old", { at: t.now() - 7 * 3_600_000 })]);
    await t.triage.tick();
    assert.equal(t.jevCalls.length, 0);
    assert.equal(t.store.untriaged().length, 0);
  } finally {
    t.stop();
  }
});

test("Jev failing leaves the messages for later and says why on Settings", async () => {
  let fail = true;
  const t = await setup({
    reply: () => {
      if (fail) throw new Error("boom");
      return answers(2, "info");
    },
  });
  try {
    t.store.addInbox([t.msg("1@c.us", "hi")]);
    await t.triage.tick();
    assert.equal(t.store.untriaged().length, 1);
    const st = (await t.ui("GET", "/api/ui/settings")).status.find((s: { group: string }) => s.group === "Triage");
    assert.equal(st.ok, false);
    fail = false;
    t.advance(2 * 60_000);
    await t.triage.tick();
    assert.equal(t.store.untriaged().length, 0);
  } finally {
    t.stop();
  }
});

test("with triage on, Refresh doesn't ask the Grok bot for a scan", async () => {
  const t = await setup();
  try {
    t.store.updateBot("dashboard", { webhookUrl: "https://hooks.example/x" });
    await t.ui("POST", "/api/ui/refresh", {});
    assert.deepEqual(t.notified, []);
    assert.equal(t.store.getBot("dashboard")!.refreshRequestedAt, null);
  } finally {
    t.stop();
  }
});

test("shadow mode decides and logs, but makes no cards, wakes and pings", async () => {
  const t = await setup({ reply: () => answers(4, "reply") });
  try {
    t.settings.update({ triageMode: "shadow" });
    t.store.addInbox([t.msg("393401234567@c.us", "Now please")]);
    await t.triage.tick();
    assert.equal(t.jevCalls.length, 1);
    assert.equal(t.store.getItemByKey("dashboard", "inbox:whatsapp:393401234567@c.us:needs"), null);
    assert.equal(t.store.triageSince(0)[0].route, "wake", "what it would have done is logged");
    assert.equal(t.triage.wakeDue(), false);
    assert.equal(t.pings.length, 0);
    assert.deepEqual((await t.bot("/api/bot/actions")).inbox, []);
    const st = (await t.ui("GET", "/api/ui/settings")).status.find((s: { group: string }) => s.group === "Triage");
    assert.match(st.text, /^Shadow: 1 chat sorted today.*Would have: 1 Grok wakes/);
    assert.equal((await t.ui("PUT", "/api/ui/settings", { values: { triageMode: "maybe" } })).error, "Mode must be one of: Off, Shadow, On.");
  } finally {
    t.stop();
  }
});

test("with triage on, the Grok bot's old run times don't make it look offline", async () => {
  const t = await setup();
  try {
    t.store.markScan("dashboard", undefined, ["14:00", "16:00"]);
    t.advance(5 * 3_600_000);
    const offline = async () => (await t.ui("GET", "/api/ui/state")).bots.find((b: { slug: string }) => b.slug === "dashboard").offlineSince;
    assert.equal(await offline(), null);
    t.settings.update({ triageMode: "shadow" });
    assert.notEqual(await offline(), null, "in shadow mode the schedule still counts");
  } finally {
    t.stop();
  }
});
