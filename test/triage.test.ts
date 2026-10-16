import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Store, type InboxInput, type InboxMessage } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { Settings } from "../server/settings.ts";
import { loadConfig } from "../server/config.ts";
import { calendarFor, createTriage, decide, routeFor, type Decision } from "../server/triage.ts";
import type { JevResult } from "../server/jev.ts";
import type { Sources } from "../server/sources/index.ts";

const TZ = "Europe/Rome";
const env = { OWNER_LOGIN: "o@x.com", BOT_TOKEN: "test-token-123", TZ };

// ---------- Decisions ----------

/** Jev's answers with its weight on one "how soon" level and one need. */
function answers(
  level: number,
  need: string,
  opts: { when?: Record<string, number>; probs?: Record<string, number>; auto?: number; addressed?: number; event?: Record<string, number>; dated?: number } = {},
): JevResult["answers"] {
  const event = opts.event ?? { none: 0.95 };
  const top = Object.entries(event).sort((a, b) => b[1] - a[1])[0][0];
  return {
    event: { type: "choice", choice: top, confidence: 0.8, probabilities: event },
    dated: { type: "noul", noul: opts.dated ?? 0.9 },
    when: { type: "score", score: level, confidence: 0.5, probabilities: opts.when ?? { [String(Math.round(level))]: 0.9 } },
    need: { type: "choice", choice: need, confidence: 0.5, probabilities: opts.probs ?? { [need]: 0.9 } },
    addressed: { type: "noul", noul: opts.addressed ?? 0.9 },
    automated: { type: "noul", noul: opts.auto ?? 0.1 },
  };
}

test("how soon counts only when Jev is clear about it", () => {
  assert.equal(decide(answers(3.4, "info", { when: { "3": 0.45, "4": 0.45 } }), 60, false).level, 3, "today or now, but not clearly now");
  assert.equal(decide(answers(3.6, "info", { when: { "3": 0.3, "4": 0.65 } }), 60, false).level, 4);
  assert.equal(decide(answers(2.9, "info", { when: { "2": 0.5, "3": 0.3, "4": 0.2 } }), 60, false).level, 2, "chat that leans today without being sure stays below today");
});

test("Grok gets a chat only when a reply or decision is likely enough; a doubt costs a card", () => {
  const sure = decide(answers(3, "reply", { probs: { reply: 0.7, nothing: 0.3 } }), 60, false);
  assert.deepEqual([sure.actionable, sure.doubtful, sure.need], [true, false, "reply"]);
  const maybe = decide(answers(3, "nothing", { probs: { reply: 0.25, decision: 0.15, nothing: 0.6 } }), 60, false);
  assert.deepEqual([maybe.actionable, maybe.doubtful, maybe.need, routeFor(maybe)], [false, true, "reply", "card"]);
  const no = decide(answers(3, "nothing", { probs: { reply: 0.2, nothing: 0.8 } }), 60, false);
  assert.deepEqual([no.actionable, no.doubtful], [false, false]);
});

test("in a group, a question needs you only when it's put to you or asks you to decide", () => {
  const toAll = decide(answers(3, "reply", { probs: { reply: 0.8 }, addressed: 0.2 }), 60, false, "group");
  assert.deepEqual([toAll.actionable, toAll.doubtful, routeFor(toAll)], [false, false, "catchup"]);
  const toYou = decide(answers(3, "reply", { probs: { reply: 0.8 }, addressed: 0.8 }), 60, false, "group");
  assert.equal(routeFor(toYou), "ride");
  const vote = decide(answers(3, "decision", { probs: { decision: 0.7 }, addressed: 0.1 }), 60, false, "group");
  assert.equal(routeFor(vote), "ride");
});

test("routes follow the table", () => {
  const r = (level: number, need: Decision["need"], o: Partial<Decision> = {}) =>
    routeFor({ level, need, actionable: false, doubtful: false, automated: false, forUser: true, chat: "private", ...o });
  assert.equal(r(4, "reply", { actionable: true }), "wake");
  assert.equal(r(3, "decision", { actionable: true }), "ride");
  assert.equal(r(1, "reply", { actionable: true }), "ride");
  assert.equal(r(2, "reply", { doubtful: true }), "card");
  assert.equal(r(2, "task"), "card");
  assert.equal(r(2, "task", { chat: "group" }), "catchup");
  assert.equal(r(1, "task"), "catchup");
  assert.equal(r(4, "info", { automated: true, chat: "email" }), "card", "an urgent automatic alert still gets a card");
  assert.equal(r(3, "info", { chat: "email" }), "card");
  assert.equal(r(2, "info", { chat: "email" }), "catchup");
  assert.equal(r(2, "info"), "card", "a person writing to you privately gets a card");
  assert.equal(r(3, "info", { chat: "group" }), "catchup");
  assert.equal(r(2, "info", { automated: true, chat: "email" }), "skip");
  assert.equal(r(0, "info"), "skip");
  assert.equal(r(4, "nothing"), "catchup", "chatter never makes a card, however recent");
  assert.equal(r(3, "nothing", { chat: "email", automated: true }), "skip");
});

// ---------- The loop, with a pretend Jev ----------

async function setup(opts: { reply?: (state: Record<string, unknown>) => JevResult["answers"]; sources?: Sources } = {}) {
  let clock = Date.parse("2026-10-12T10:00:00Z");
  const config = { ...loadConfig(env), publicDir: new URL("../public", import.meta.url).pathname.replace(/\/$/, "") };
  const store = new Store(":memory:", () => clock);
  const settings = new Settings(store, config, env);
  const jevCalls: Record<string, unknown>[] = [];
  const jevQuestions: string[] = [];
  const pings: { url: string; body: string; headers: Headers }[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      const body = JSON.parse(String(init?.body));
      jevCalls.push(body.state);
      jevQuestions.push(Object.keys(body.questions).sort().join(","));
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
  const server = http.createServer(createApp({ config, store, settings, triage, sources: opts.sources, log: () => {}, notify: (b, r) => notified.push(`${b}:${r}`) }));
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
    store, settings, triage, jevCalls, jevQuestions, pings, notified, msg, bot, ui, base,
    /** Full decisions only, not the calendar-only question asked about your own replies and live chats. */
    decisions: () => jevQuestions.filter((q) => q.includes("need")).length,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    stop: () => { server.closeAllConnections(); server.close(); store.close(); },
  };
}

test("a reply needed now: urgent card, no phone ping, Grok woken and handed the chat", async () => {
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

    assert.equal(t.pings.length, 0, "WhatsApp already told you: the dashboard never pings for a message");

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
    assert.equal(t.jevCalls.length, 0, "under two minutes of quiet: wait");
    t.advance(120_000);
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
    t.store.addWake("actions", "dashboard"); // a tap woke Grok a minute ago
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
    assert.equal(t.decisions(), 1, "your own message gets no full decision");
    assert.equal(t.jevQuestions.at(-1), "addressed,automated,dated,event", "only the calendar questions");
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

// ---------- Review fixes ----------

test("a wake Grok never answers isn't repeated for the same chats, only for new ones", async () => {
  const t = await setup({ reply: () => answers(4, "reply") });
  try {
    t.store.addInbox([t.msg("1@c.us", "now!")]);
    await t.triage.tick();
    assert.equal(t.triage.wakeDue(), true);
    t.triage.woke();
    t.store.addWake("inbox", "dashboard");
    t.advance(50 * 60_000);
    assert.equal(t.triage.wakeDue(), false, "same chat, nothing new: no second paid wake");
    t.store.addInbox([t.msg("2@c.us", "also now!", { at: t.now() - 120_000 })]);
    await t.triage.tick();
    assert.equal(t.triage.wakeDue(), true, "a new chat is worth a wake");
  } finally {
    t.stop();
  }
});

test("several bursts in one chat stay one entry for Grok and count as one chat", async () => {
  const t = await setup({ reply: () => answers(3, "reply") });
  try {
    for (const text of ["a", "b", "c"]) {
      t.store.addInbox([t.msg("1@c.us", text, { at: t.now() - 120_000 })]);
      await t.triage.tick();
      t.advance(5 * 60_000);
    }
    assert.equal(t.store.grokQueue().length, 1);
    assert.equal(t.triage.wakeDue(), false, "one chat isn't a batch of 3");
    const inbox = (await t.bot("/api/bot/actions")).inbox;
    assert.equal(inbox.length, 1);
    assert.deepEqual(inbox[0].messages.filter((m: { isNew: boolean }) => m.isNew).map((m: { text: string }) => m.text), ["a", "b", "c"]);
    assert.equal(t.jevCalls.at(-1)!.new_messages instanceof Array && (t.jevCalls.at(-1)!.new_messages as unknown[]).length, 3, "Jev judged all three together");
  } finally {
    t.stop();
  }
});

test("a later 'never mind' takes the chat off Grok's list", async () => {
  let n = 0;
  const t = await setup({ reply: () => (n++ === 0 ? answers(4, "reply") : answers(1, "nothing")) });
  try {
    t.store.addInbox([t.msg("1@c.us", "Can you call me?")]);
    await t.triage.tick();
    assert.equal(t.store.grokQueue().length, 1);
    t.store.addInbox([t.msg("1@c.us", "Never mind, sorted", { at: t.now() })]);
    t.advance(2 * 60_000);
    await t.triage.tick();
    assert.equal(t.store.grokQueue().length, 0);
    assert.equal(t.triage.wakeDue(), false);
  } finally {
    t.stop();
  }
});

test("chats Grok took but never confirmed come back once, then stay with you", async () => {
  const t = await setup({ reply: () => answers(4, "reply") });
  try {
    t.store.addInbox([t.msg("1@c.us", "now!")]);
    await t.triage.tick();
    assert.equal((await t.bot("/api/bot/actions")).inbox.length, 1);
    t.advance(31 * 60_000);
    await t.triage.tick();
    assert.equal(t.store.grokQueue().length, 1, "queued again");
    assert.equal(t.triage.wakeDue(), true, "worth one more wake");
    assert.equal((await t.bot("/api/bot/actions")).inbox.length, 1);
    t.advance(31 * 60_000);
    await t.triage.tick();
    assert.equal(t.store.grokQueue().length, 0, "two hand-outs is the limit");
    assert.equal(t.store.triageSince(0).find((r) => r.route === "wake")!.grok, "failed");
  } finally {
    t.stop();
  }
});

test("Grok writing the card confirms the chat", async () => {
  const t = await setup({ reply: () => answers(4, "reply") });
  try {
    t.store.addInbox([t.msg("1@c.us", "now!")]);
    await t.triage.tick();
    const [item] = (await t.bot("/api/bot/actions")).inbox;
    await fetch(t.base + "/api/bot/items", {
      method: "POST",
      headers: { Authorization: "Bearer test-token-123", "X-Bot": "dashboard", "Content-Type": "application/json" },
      body: JSON.stringify({ key: item.key, kind: "draft", title: "Reply to Marco", draft: { to: "Marco", text: "On my way" } }),
    });
    t.advance(31 * 60_000);
    await t.triage.tick();
    assert.equal(t.store.grokQueue().length, 0);
    assert.equal(t.store.triageSince(0).find((r) => r.route === "wake")!.grok, "done");
  } finally {
    t.stop();
  }
});

test("switching to Shadow while Jev answers keeps the page untouched", async () => {
  let settingsRef: Settings | null = null;
  const t = await setup({
    reply: () => {
      settingsRef!.update({ triageMode: "shadow" });
      return answers(4, "reply");
    },
  });
  settingsRef = t.settings;
  try {
    t.store.addInbox([t.msg("1@c.us", "now!")]);
    await t.triage.tick();
    assert.equal(t.store.getItemByKey("dashboard", "inbox:whatsapp:1@c.us:needs"), null);
    assert.equal(t.pings.length, 0);
    assert.equal(t.store.grokQueue().length, 0);
  } finally {
    t.stop();
  }
});

test("other bots' runs don't use up Grok's cooldown or ceiling", async () => {
  const t = await setup({ reply: () => answers(4, "reply") });
  try {
    for (let i = 0; i < 12; i++) t.store.addWake("refresh", "venduto");
    t.store.addInbox([t.msg("1@c.us", "now!")]);
    await t.triage.tick();
    assert.equal(t.triage.wakeDue(), true);
    assert.equal(t.triage.runsToday(), 0);
  } finally {
    t.stop();
  }
});

test("an OpenRouter outage delays decisions but loses no message; old history is filed", async () => {
  let down = true;
  const t = await setup({
    reply: () => {
      if (down) throw new Error("outage");
      return answers(3, "info");
    },
  });
  try {
    await t.triage.tick(); // triage turns on now
    t.store.addInbox([t.msg("1@c.us", "on time", { at: t.now() })]);
    t.store.addInbox([t.msg("2@c.us", "history from when WhatsApp was linked", { at: t.now() - 3 * 86_400_000 })]);
    t.advance(2 * 60_000);
    await t.triage.tick();
    t.advance(7 * 3_600_000);
    down = false;
    await t.triage.tick();
    assert.ok(t.store.getItemByKey("dashboard", "inbox:whatsapp:1@c.us:needs"), "decided after the outage");
    assert.equal(t.store.getItemByKey("dashboard", "inbox:whatsapp:2@c.us:needs"), null, "history isn't decided late");
    assert.equal(t.store.untriaged().length, 0);
  } finally {
    t.stop();
  }
});

test("a snoozed draft from Grok is kept when the chat moves on", async () => {
  const t = await setup({ reply: () => answers(3, "info") });
  try {
    const { item } = t.store.upsertItem({ bot: "dashboard", key: "inbox:whatsapp:1@c.us:needs", section: "needs", kind: "draft", title: "Reply", draft: { to: "Marco", text: "Yes" } });
    t.store.snoozeItem(item.id, t.now() + 3_600_000);
    t.store.addInbox([t.msg("1@c.us", "and another thing")]);
    await t.triage.tick();
    assert.equal(t.store.getItem(item.id)!.draft!.text, "Yes");
  } finally {
    t.stop();
  }
});

// ---------- Review round two ----------

test("a database from the first triage commit gets the new columns", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gbd-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE triage (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, thread TEXT NOT NULL, message_ids TEXT NOT NULL,
    decided_at INTEGER NOT NULL, answers TEXT NOT NULL DEFAULT '{}', level INTEGER NOT NULL, need TEXT NOT NULL, route TEXT NOT NULL,
    item_id INTEGER, grok TEXT, grok_at INTEGER, cost REAL NOT NULL DEFAULT 0);
    CREATE TABLE wakes (at INTEGER NOT NULL, reason TEXT NOT NULL);`);
  old.close();
  const store = new Store(file);
  store.addWake("inbox", "dashboard");
  store.addTriage({ source: "whatsapp", thread: "1@c.us", messageIds: [], decidedAt: 1, answers: {}, level: 4, need: "reply", route: "wake", itemId: null, grok: "queued", cost: 0 });
  assert.equal(store.grokQueue().length, 1);
  assert.equal(store.wakesSince(0, "dashboard").length, 1);
  store.close();
  fs.rmSync(path.dirname(file), { recursive: true });
});

test("'never mind' after Grok took the chat doesn't bring it back later", async () => {
  let n = 0;
  const t = await setup({ reply: () => (n++ === 0 ? answers(4, "reply") : answers(1, "nothing")) });
  try {
    t.store.addInbox([t.msg("1@c.us", "Call me?")]);
    await t.triage.tick();
    assert.equal((await t.bot("/api/bot/actions")).inbox.length, 1, "Grok took it");
    t.store.addInbox([t.msg("1@c.us", "Never mind", { at: t.now() })]);
    t.advance(2 * 60_000);
    await t.triage.tick();
    t.advance(31 * 60_000);
    await t.triage.tick();
    assert.equal(t.store.grokQueue().length, 0);
    assert.equal(t.triage.wakeDue(), false);
  } finally {
    t.stop();
  }
});

test("a draft Grok posts after its lease ran out still settles the chat", async () => {
  const t = await setup({ reply: () => answers(4, "reply") });
  try {
    t.store.addInbox([t.msg("1@c.us", "now!")]);
    await t.triage.tick();
    const [item] = (await t.bot("/api/bot/actions")).inbox;
    t.advance(31 * 60_000);
    await t.triage.tick();
    assert.equal(t.store.grokQueue().length, 1, "queued again");
    t.triage.ack(item.key);
    assert.equal(t.store.grokQueue().length, 0);
    assert.equal(t.triage.wakeDue(), false);
  } finally {
    t.stop();
  }
});

test("Grok taking a chat while Jev decides on new messages leaves one entry", async () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let n = 0;
  t = await setup({
    reply: () => {
      // The second decision: Grok grabs the queue while Jev is still answering.
      if (n++ === 1) t.store.claimGrokQueue();
      return answers(3, "reply");
    },
  });
  try {
    t.store.addInbox([t.msg("1@c.us", "a")]);
    await t.triage.tick();
    t.store.addInbox([t.msg("1@c.us", "b", { at: t.now() })]);
    t.advance(2 * 60_000);
    await t.triage.tick();
    const owed = t.store.triageSince(0).filter((r) => r.grok === "queued" || r.grok === "sent");
    assert.equal(owed.length, 1);
    assert.equal(owed[0].messageIds.length, 2);
  } finally {
    t.stop();
  }
});

test("a new urgent message in a chat Grok didn't answer wakes it after the cooldown", async () => {
  const t = await setup({ reply: () => answers(4, "reply") });
  try {
    t.store.addInbox([t.msg("1@c.us", "now!")]);
    await t.triage.tick();
    t.triage.woke();
    t.store.addWake("inbox", "dashboard");
    t.advance(50 * 60_000);
    t.store.addInbox([t.msg("1@c.us", "hello?? really urgent", { at: t.now() - 120_000 })]);
    await t.triage.tick();
    assert.equal(t.triage.wakeDue(), true);
  } finally {
    t.stop();
  }
});

test("a message from just before triage was switched on survives a long outage", async () => {
  let down = true;
  const t = await setup({
    reply: () => {
      if (down) throw new Error("outage");
      return answers(3, "info");
    },
  });
  try {
    t.store.setState("triage:onSince", null);
    t.store.addInbox([t.msg("1@c.us", "just before", { at: t.now() - 60_000 })]);
    t.advance(10_000);
    await t.triage.tick();
    t.advance(7 * 3_600_000);
    down = false;
    await t.triage.tick();
    assert.ok(t.store.getItemByKey("dashboard", "inbox:whatsapp:1@c.us:needs"));
  } finally {
    t.stop();
  }
});

test("Refresh wakes Grok when chats are waiting for it", async () => {
  const t = await setup({ reply: () => answers(2, "reply") });
  try {
    t.store.addInbox([t.msg("1@c.us", "whenever")]);
    await t.triage.tick();
    assert.equal(t.triage.wakeDue(), false);
    await t.ui("POST", "/api/ui/refresh", {});
    assert.deepEqual(t.notified, ["dashboard:inbox"]);
  } finally {
    t.stop();
  }
});

test("chats left over after Grok's 30 per run wake it again", async () => {
  const t = await setup({ reply: () => answers(4, "reply") });
  try {
    t.store.addInbox(Array.from({ length: 31 }, (_, i) => t.msg(`${i}@c.us`, "now!")));
    for (let i = 0; i < 3; i++) await t.triage.tick();
    assert.equal(t.store.grokQueue().length, 31);
    t.triage.woke();
    t.store.addWake("inbox", "dashboard");
    t.advance(60_000);
    assert.equal((await t.bot("/api/bot/actions")).inbox.length, 30);
    t.advance(50 * 60_000);
    assert.equal(t.triage.wakeDue(), true, "Grok answered the last wake, so the 31st gets one");
  } finally {
    t.stop();
  }
});

test("while you're chatting in a chat yourself, its new messages need no decision", async () => {
  const t = await setup({ reply: () => answers(4, "reply") });
  try {
    t.store.addInbox([t.msg("1@c.us", "my turn", { fromMe: true, sender: "You", at: t.now() - 10 * 60_000 })]);
    await t.triage.tick();
    t.store.addInbox([t.msg("1@c.us", "ahah true", { at: t.now() - 5 * 60_000 })]);
    await t.triage.tick();
    assert.equal(t.decisions(), 0);
    assert.equal(t.store.grokQueue().length, 0);
    assert.equal(t.store.triageSince(0).at(-1)!.route, "active");
    t.store.addInbox([t.msg("1@c.us", "are you there? need an answer", { at: t.now() + 30 * 60_000 })]);
    t.advance(33 * 60_000);
    await t.triage.tick();
    assert.equal(t.decisions(), 1, "once you've been quiet a while, it's decided again");
  } finally {
    t.stop();
  }
});

// ---------- Calendar ----------

test("an event that's already set is added without asking: Grok gets it, the card says so", async () => {
  const t = await setup({ reply: () => answers(2, "info", { event: { fixed: 0.8, none: 0.2 } }) });
  try {
    t.store.addInbox([t.msg("1@c.us", "L'esame è confermato per lunedì 20 alle 9:00", { extId: "e1" })]);
    await t.triage.tick();
    const card = t.store.getItemByKey("dashboard", "inbox:whatsapp:1@c.us:event:e1")!;
    assert.deepEqual([card.kind, card.context], ["reminder", "Grok adds this to your calendar at its next run."]);
    const [item] = (await t.bot("/api/bot/actions")).inbox;
    assert.deepEqual([item.task, item.key], ["calendar", "inbox:whatsapp:1@c.us:event:e1"]);
    assert.match(item.instruction, /deadline with a time becomes an event at that time/);
    // Grok adds it and closes the card: done.
    await fetch(t.base + "/api/bot/items/close", {
      method: "POST",
      headers: { Authorization: "Bearer test-token-123", "X-Bot": "dashboard", "Content-Type": "application/json" },
      body: JSON.stringify({ key: item.key, reason: "Added to calendar: Esame, lun 20 ott 9:00" }),
    });
    assert.equal(t.store.triageSince(0).find((r) => r.route === "calendar")!.grok, "done");
  } finally {
    t.stop();
  }
});

test("an open invitation gets an Add to calendar button and no Grok run", async () => {
  const t = await setup({ reply: () => answers(2, "info", { event: { proposal: 0.7, none: 0.3 } }) });
  try {
    t.store.addInbox([t.msg("1@c.us", "Venerdì sera pizza da me, ci sei?", { extId: "p1" })]);
    await t.triage.tick();
    const card = t.store.getItemByKey("dashboard", "inbox:whatsapp:1@c.us:event:p1")!;
    assert.equal(card.kind, "choice");
    assert.deepEqual(card.options.map((o) => o.label), ["Add to calendar"]);
    assert.equal(card.context, "Tap Add to calendar and Grok puts it in your main Google Calendar.");
    assert.equal(t.store.grokQueue().length, 0);
  } finally {
    t.stop();
  }
});

test("plans you agree to in your own reply get calendarized, and the card survives your reply", async () => {
  const t = await setup({ reply: (state) => (Array.isArray(state.new_messages) && (state.new_messages as { from: string }[]).some((m) => m.from === "the user") ? answers(2, "info", { event: { fixed: 0.75, none: 0.25 } }) : answers(2, "nothing")) });
  try {
    t.store.addInbox([t.msg("1@c.us", "Ok, ci vediamo venerdì alle 20 al Caffè", { fromMe: true, sender: "You", extId: "me1" })]);
    await t.triage.tick();
    const card = t.store.getItemByKey("dashboard", "inbox:whatsapp:1@c.us:event:me1")!;
    assert.equal(card.status, "open");
    assert.equal(t.store.grokQueue().length, 1);
  } finally {
    t.stop();
  }
});

test("ads and other people's plans never touch your calendar", () => {
  const ad = answers(1, "info", { event: { deadline: 0.5, proposal: 0.4, none: 0.1 }, auto: 0.95 });
  assert.equal(calendarFor(ad, "email", true), null, "a sale that ends Sunday");
  const booking = answers(2, "info", { event: { fixed: 0.9 }, auto: 0.95 });
  assert.equal(calendarFor(booking, "email", true), "auto", "a booking confirmation from a machine still counts");
  const groupPlan = answers(1, "nothing", { event: { proposal: 0.8 }, addressed: 0.1 });
  assert.equal(calendarFor(groupPlan, "group", false), null);
  assert.equal(calendarFor(answers(1, "info", { event: { proposal: 0.8 }, addressed: 0.8 }), "group", false), "ask");
  assert.equal(calendarFor(answers(1, "info", { event: { fixed: 0.9 }, dated: 0.2 }), "private", false), null, "\"I'm on my way\" has no day to put in a calendar");
});

test("group talk that isn't for you is archived, never shown", async () => {
  const t = await setup({ reply: () => answers(2, "info", { addressed: 0.1 }) });
  try {
    t.store.addInbox([t.msg("group@g.us", "lol", { isGroup: true, threadName: "group" })]);
    await t.triage.tick();
    const digest = t.store.getItemByKey("dashboard", "inbox:whatsapp:group@g.us:digest")!;
    assert.deepEqual([digest.status, digest.closedReason], ["closed", "quiet"]);
    assert.equal(t.store.archive("lol", 30).items.length, 1, "search still finds it");
    assert.equal((await t.ui("GET", "/api/ui/state")).catchup.length, 0);
  } finally {
    t.stop();
  }
});


test("a chat waiting for Grok's answer needs you before Grok writes it", async () => {
  const t = await setup({ reply: () => answers(3, "reply") });
  try {
    t.store.addInbox([t.msg("1@c.us", "Can you send me the notes?")]);
    await t.triage.tick();
    const card = t.store.getItemByKey("dashboard", "inbox:whatsapp:1@c.us:needs")!;
    const st = await t.ui("GET", "/api/ui/state");
    assert.deepEqual([st.needs.map((c: { id: number }) => c.id), st.catchup.length], [[card.id], 0]);
  } finally {
    t.stop();
  }
});

test("with triage on, Updated means the last read of your sources, not Grok's last scan", async () => {
  let read: number | null = null;
  const sources = { lastRead: () => read, problems: () => [], calendarOn: () => false } as unknown as Sources;
  const t = await setup({ sources });
  try {
    t.store.ensureBot("dashboard");
    t.store.markScan("dashboard", t.now() - 86_400_000);
    assert.equal((await t.ui("GET", "/api/ui/state")).lastScanAt, null, "Grok no longer scans: its old scan doesn't count");
    read = t.now() - 60_000;
    assert.equal((await t.ui("GET", "/api/ui/state")).lastScanAt, read);
  } finally {
    t.stop();
  }
});
