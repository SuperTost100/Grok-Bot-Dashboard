// Triage: Jev reads each burst of new messages in a chat or mail thread and decides what happens.
// Most messages become cards built from the message itself, a line in catch-up, or nothing.
// Only replies and decisions need Grok, and Grok wakes for them under a cooldown and a daily ceiling.
// None of Jev's labels show on the page; they only decide where a message goes.

import type { InboxMessage, ItemInput, Store, TriageRow } from "./store.ts";
import type { Settings } from "./settings.ts";
import { askJev, JevError, type ChoiceAnswer, type JevResult, type NoulAnswer, type Question, type ScoreAnswer } from "./jev.ts";
import { pingPhone } from "./ntfy.ts";
import { localStamp, zonedToEpoch } from "./time.ts";

type Fetch = typeof fetch;

/** How soon the user needs to see it, lowest first. Jev answers with a position on this scale. */
export const LEVELS = ["never", "whenever", "this week", "today", "now"] as const;
export const NOW = 4;
export const TODAY = 3;

export const QUESTIONS: Record<string, Question> = {
  when: {
    type: "score",
    instructions: "How soon does the user need to see the new messages?",
    criteria: [
      "Never: spam, ads, or an automatic notice of no consequence to the user.",
      "Whenever: nice to know, no rush. A glance once a week is enough.",
      "This week: it matters in the next few days.",
      "Today: the user should see it today.",
      "Now: it needs the user within about two hours, like someone waiting on them right now, a meeting soon, or a deadline today.",
    ],
  },
  need: {
    type: "choice",
    instructions: "What do the new messages need from the user?",
    criteria: {
      reply: "Someone wrote to the user personally and expects an answer from them.",
      decision: "The user has to choose or approve something: a poll, a date, a yes or no, a payment.",
      task: "The user has to do something themselves that isn't a reply: bring, pay, sign up, go somewhere.",
      info: "Useful information for the user that needs no action.",
      nothing: "Chatter, noise, or something that's already handled.",
    },
  },
  automated: {
    type: "noul",
    instructions: "Did a machine or a mass sender write the new messages, not a person writing to the user?",
    criteria: {
      true: "A newsletter, notification, receipt, marketing message or automatic alert.",
      false: "A person writing to the user or to a group the user is in.",
    },
  },
};

export type Need = "reply" | "decision" | "task" | "info" | "nothing";
export type Route = "wake" | "ride" | "card" | "catchup" | "skip";

export interface Decision {
  level: number;
  need: Need;
  /** Needs Grok: a reply to write or an answer to give on the user's behalf. */
  actionable: boolean;
  automated: boolean;
  unsure: boolean;
}

/**
 * Jev's answers as one decision. When Jev is unsure, the message counts as more urgent and,
 * if a reply is at all likely, as needing one: a doubt costs a card, not a missed message.
 */
export function decide(answers: JevResult["answers"], unsurePct: number, automatedHint: boolean): Decision {
  const when = answers.when as ScoreAnswer;
  const need = answers.need as ChoiceAnswer;
  const auto = answers.automated as NoulAnswer;
  const unsureAt = unsurePct / 100;
  const whenUnsure = (when.confidence ?? 1) < unsureAt;
  const needUnsure = (need.confidence ?? 1) < unsureAt;
  const score = Math.max(0, Math.min(NOW, when.score));
  const level = whenUnsure ? Math.ceil(score) : Math.round(score);
  const p = need.probabilities ?? {};
  const replyLikely = (p.reply ?? 0) + (p.decision ?? 0) >= 0.35;
  const actionable = need.choice === "reply" || need.choice === "decision" || (needUnsure && replyLikely);
  let picked = need.choice as Need;
  if (actionable && picked !== "reply" && picked !== "decision") picked = (p.decision ?? 0) > (p.reply ?? 0) ? "decision" : "reply";
  const automated = auto.noul >= 0.7 || (automatedHint && auto.noul >= 0.4);
  return { level, need: picked, actionable, automated, unsure: whenUnsure || needUnsure };
}

/** Where a decision sends the messages. The table in the README matches this. */
export function routeFor(d: Decision): Route {
  if (d.actionable && !(d.automated && d.level <= 1)) return d.level >= NOW ? "wake" : "ride";
  if (d.level >= TODAY) return "card";
  if (d.need === "task" && d.level >= 2) return "card";
  if (d.need === "nothing" || d.level === 0 || d.automated) return "skip";
  return "catchup";
}

// ---------- What Jev reads ----------

export interface SourceInfo {
  /** "WhatsApp · Lab group", "Gmail · Marco Rossi" */
  label: string;
  app: string;
  /** How the state describes where the messages are. */
  where: string;
}

const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function stateFor(
  msgs: InboxMessage[],
  context: InboxMessage[],
  info: SourceInfo,
  about: string,
  now: number,
  tz: string,
): Record<string, unknown> {
  const when = (m: InboxMessage) => localStamp(new Date(m.at), tz).replace("T", " ").slice(0, 16);
  const line = (m: InboxMessage, max: number) => ({ from: m.fromMe ? "the user" : m.sender, at: when(m), text: cut(m.text, max) });
  const incoming = msgs.filter((m) => !m.fromMe);
  const first = msgs[0];
  return {
    now: new Date(now).toLocaleString("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }),
    about_the_user: about || "No details given.",
    where: info.where,
    ...(first.subject ? { subject: first.subject } : {}),
    // The newest 15 new messages; a long burst keeps its end, which is usually where the question is.
    new_messages: msgs.slice(-15).map((m) => line(m, 1500)),
    ...(msgs.length > 15 ? { earlier_new_messages_not_shown: msgs.length - 15 } : {}),
    earlier_messages_for_context: context.slice(-8).map((m) => line(m, 400)),
    sender_headers_say_automated: incoming.length > 0 && incoming.every((m) => m.automated),
  };
}

// ---------- Cards built from the messages ----------

export const cardKey = (source: string, thread: string, kind: "needs" | "digest") => `inbox:${source}:${thread}:${kind}`;

function urgentLabel(d: Decision): string {
  if (d.level < NOW) return "";
  return d.need === "reply" ? "Reply soon" : d.need === "decision" ? "Decide soon" : "Soon";
}

/** A card for the Needs you section, made from the messages without any model writing text. */
export function needsCard(bot: string, msgs: InboxMessage[], info: SourceInfo, d: Decision, tz: string): ItemInput {
  const incoming = msgs.filter((m) => !m.fromMe);
  const last = incoming.at(-1) ?? msgs.at(-1)!;
  const isMail = last.source.startsWith("mail:");
  const title = isMail ? last.threadName || firstLine(last.text) : `${last.sender}: ${firstLine(last.text)}`;
  const time = (m: InboxMessage) => localStamp(new Date(m.at), tz).slice(11, 16);
  const body = isMail
    ? last.text
    : incoming.slice(-6).map((m) => (last.isGroup ? `${m.sender}, ${time(m)}: ${m.text}` : `${time(m)}  ${m.text}`)).join("\n");
  const number = /^(\d{6,15})@c\.us$/.exec(last.thread)?.[1];
  return {
    bot,
    key: cardKey(last.source, last.thread, "needs"),
    section: "needs",
    kind: "reminder",
    title: cut(title || "New message", 140),
    body: cut(body, 2000),
    source: cut(info.label, 120),
    app: info.app,
    link: last.link || (number ? `https://wa.me/${number}` : ""),
    urgent: urgentLabel(d),
    // New messages in a chat whose card you closed are news, so the card comes back.
    reopen: true,
  };
}

/** A catch-up line for a chat that needs no answer: how many messages, and the latest ones. */
export function digestCard(bot: string, recent: InboxMessage[], info: SourceInfo): ItemInput {
  const incoming = recent.filter((m) => !m.fromMe);
  const last = recent.at(-1)!;
  const lines = incoming.slice(-3).map((m) => `${m.sender}: ${cut(firstLine(m.text), 160)}`);
  return {
    bot,
    key: cardKey(last.source, last.thread, "digest"),
    section: "catchup",
    kind: "digest",
    title: cut(last.source.startsWith("mail:") ? last.threadName : info.label.replace(/^WhatsApp · /, ""), 140),
    body: lines.join("\n"),
    source: cut(info.label, 120),
    app: info.app,
    link: last.link,
    countLabel: `${incoming.length} message${incoming.length === 1 ? "" : "s"}`,
  };
}

// ---------- The loop ----------

/** Wait for a chat to go quiet this long, so a burst of messages is one decision. */
const QUIET_MS = 60_000;
/** But not longer than this for a chat that never stops. */
const MAX_WAIT_MS = 3 * 60_000;
/** Messages older than this when triage first sees them (it was off, or the server was down) are filed without a decision. */
const STALE_MS = 6 * 3_600_000;
const GROUPS_PER_RUN = 15;
/** A chat that needs Grok but isn't urgent still gets a wake after a day. */
const MAX_QUEUE_AGE_MS = 24 * 3_600_000;
/** Grok took chats but never wrote or closed their cards in this long: hand them out again. */
const CLAIM_LEASE_MS = 30 * 60_000;
/** Hand-outs per chat before giving up on Grok for it. The card stays for you. */
const MAX_HANDOUTS = 2;

/** At most one phone ping in this long; later urgent cards wait for the next one. */
const PING_GAP_MS = 10 * 60_000;

export interface TriageStatus { group: string; on: boolean; ok: boolean; text: string }

export interface Triage {
  /** Jev is deciding (shadow or on). */
  on(): boolean;
  /** Triage makes the cards and wakes Grok. */
  active(): boolean;
  tick(): Promise<void>;
  /** Whether Grok should be woken for waiting chats now. */
  wakeDue(): boolean;
  /** Record that a wake was sent, so the cooldown starts. */
  woke(): void;
  /** The chats waiting for Grok, handed to it with its actions. */
  claimForGrok(): ReturnType<typeof forGrok>[];
  /** Grok wrote or closed a card: the chat it was handed for is done. */
  ack(key: string): void;
  /** Chats waiting for Grok. */
  waiting(): number;
  status(): TriageStatus[];
  runsToday(): number;
}

export interface TriageDeps {
  store: Store;
  settings: Settings;
  tz: string;
  log: (msg: string) => void;
  sourceInfo: (m: InboxMessage) => SourceInfo;
  fetch?: Fetch;
}

/** What Grok gets for one waiting chat: the card to fill in, and the messages. */
export function forGrok(store: Store, t: TriageRow, info: SourceInfo, tz: string) {
  const msgs = store.threadMessages(t.source, t.thread, 25);
  const newIds = new Set(t.messageIds);
  const last = msgs.at(-1);
  return {
    id: t.id,
    key: cardKey(t.source, t.thread, "needs"),
    source: info.label,
    app: info.app,
    chat: last?.threadName ?? "",
    isGroup: last?.isGroup ?? false,
    urgent: t.level >= NOW,
    need: t.need,
    link: last?.link ?? "",
    messages: msgs.map((m) => ({ from: m.fromMe ? "you" : m.sender, at: localStamp(new Date(m.at), tz), text: m.text, isNew: newIds.has(m.id) })),
  };
}

export function createTriage(deps: TriageDeps): Triage {
  const { store, settings, tz, log } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  let running: Promise<void> | null = null;
  let error = "";
  let retryAt = 0;
  let lastAttempt = 0;
  let lastPing = 0;
  let unpinged = 0;

  /** Jev decides: in shadow mode it only logs, when on it acts. */
  const on = () => Boolean(settings.str("openrouterKey")) && settings.str("triageMode") !== "off";
  const active = () => on() && settings.str("triageMode") === "on";
  const bot = () => settings.str("grokBot") || "dashboard";
  const dayStart = () => zonedToEpoch(`${localStamp(new Date(store.now()), tz).slice(0, 10)}T00:00:00`, tz);

  async function phone(urgentCards: number) {
    const topic = settings.str("ntfyTopic");
    if (!topic || !urgentCards) return;
    unpinged += urgentCards;
    if (store.now() - lastPing < PING_GAP_MS) return;
    try {
      await pingPhone(settings.str("ntfyServer") || "https://ntfy.sh", topic, unpinged, settings.str("dashboardUrl"), fetchImpl);
      lastPing = store.now();
      unpinged = 0;
    } catch (err) {
      log(`phone ping failed: ${(err as Error).message}`);
    }
  }

  /** You wrote last in this chat: the cards about it are settled, and Grok doesn't need it. */
  function replied(msgs: InboxMessage[]) {
    const last = msgs.at(-1)!;
    store.dropFromGrokQueue(last.source, last.thread);
    const how = last.source === "whatsapp" ? "You replied on WhatsApp" : "You replied by mail";
    for (const card of store.triageCards(bot(), last.source, last.thread)) {
      if (card.section === "needs" && !store.pendingActionFor(card.id)) store.closeItem(card.id, "bot", how);
    }
  }

  /** Rebuild today's list of what was filtered out, so you can check nothing important went missing. */
  function updateSkipped() {
    const since = dayStart();
    const rows = store.triageSince(since).filter((t) => t.route === "skip");
    if (!rows.length) return;
    const lines: string[] = [];
    let messages = 0;
    for (const t of rows.toReversed()) {
      const msgs = store.threadMessages(t.source, t.thread, 50).filter((m) => t.messageIds.includes(m.id) && !m.fromMe);
      messages += msgs.length;
      const m = msgs.at(-1);
      if (m && lines.length < 15) lines.push(`${deps.sourceInfo(m).label}: ${cut(firstLine(m.subject || m.text), 120)}`);
    }
    store.upsertItem(
      {
        bot: bot(),
        key: `inbox:skipped:${localStamp(new Date(store.now()), tz).slice(0, 10)}`,
        section: "catchup",
        kind: "digest",
        title: "Filtered out today",
        body: lines.join("\n") + (rows.length > lines.length ? `\n…and ${rows.length - lines.length} more` : ""),
        source: "Triage",
        app: "",
        countLabel: `${messages} message${messages === 1 ? "" : "s"}`,
      },
      { asServer: true },
    );
  }

  async function handle(fresh: InboxMessage[]): Promise<number> {
    const last = fresh.at(-1)!;
    const ids = fresh.map((m) => m.id);
    if (last.fromMe) {
      if (active()) replied(fresh);
      store.addTriage({ source: last.source, thread: last.thread, messageIds: ids, decidedAt: store.now(), answers: {}, level: -1, need: "replied", route: "replied", itemId: null, grok: null, cost: 0 });
      store.markTriaged(ids);
      return 0;
    }
    // Messages still waiting for Grok in this chat are judged again together with the new ones,
    // so a later "never mind" can take the chat off Grok's list, and the chat stays one entry.
    const pending = active() ? store.outstandingFor(last.source, last.thread) : null;
    const earlier = pending ? store.inboxByIds(pending.messageIds).filter((m) => !ids.includes(m.id)) : [];
    const msgs = [...earlier, ...fresh];
    const allIds = msgs.map((m) => m.id);
    const info = deps.sourceInfo(last);
    const context = store.threadMessages(last.source, last.thread, 40).filter((m) => m.at < msgs[0].at || (m.at === msgs[0].at && m.id < msgs[0].id));
    const state = stateFor(msgs, context, info, settings.str("triageAbout"), store.now(), tz);
    const result = await askJev(settings.str("openrouterKey"), settings.str("jevModel") || "typesafe/jev-1.13", state, QUESTIONS, fetchImpl);
    const d = decide(result.answers, settings.int("triageUnsure"), msgs.some((m) => m.automated));
    let route = routeFor(d);
    // The mode may have changed while Jev answered: act on the mode as it is now.
    if (!active()) {
      // Shadow: remember what triage would have done, and change nothing.
      store.addTriage({
        source: last.source, thread: last.thread, messageIds: ids, decidedAt: store.now(),
        answers: { ...result.answers, model: result.model, unsure: d.unsure, automated: d.automated, shadow: true },
        level: d.level, need: d.need, route, itemId: null, grok: null, cost: result.cost,
      });
      store.markTriaged(ids);
      return 0;
    }
    // Grok already wrote a draft or answers on this chat's card: news in the chat goes back to Grok
    // to update them, instead of a plain card replacing its work.
    const key = cardKey(last.source, last.thread, "needs");
    const existing = store.getItemByKey(bot(), key);
    const grokWrote = existing && ["open", "pending", "snoozed"].includes(existing.status) && (existing.kind === "draft" || existing.kind === "choice");
    if (route === "card" && grokWrote) route = "ride";
    const forGrokNow = route === "wake" || route === "ride";
    let itemId: number | null = null;
    let urgent = 0;
    if (grokWrote && forGrokNow) {
      // The card keeps Grok's draft until Grok updates it at its next wake.
      itemId = existing.id;
      if (d.level >= NOW) urgent = 1;
    } else if (forGrokNow || route === "card") {
      const r = store.upsertItem(needsCard(bot(), msgs, info, d, tz), { asServer: true });
      itemId = r.item.id;
      if (d.level >= NOW && !r.ignored) urgent = 1;
    } else if (route === "catchup") {
      const recent = store.threadMessages(last.source, last.thread, 60).filter((m) => m.at > store.now() - 86_400_000);
      itemId = store.upsertItem(digestCard(bot(), recent.length ? recent : msgs, info), { asServer: true }).item.id;
    }
    store.tx(() => {
      // This decision replaces whatever Grok still owed for the chat (looked up again: Grok may have
      // taken it while Jev answered). It keeps that one's place in line.
      store.dropFromGrokQueue(last.source, last.thread);
      store.addTriage({
        source: last.source, thread: last.thread, messageIds: forGrokNow ? allIds : ids, decidedAt: store.now(),
        answers: { ...result.answers, model: result.model, unsure: d.unsure, automated: d.automated },
        level: d.level, need: d.need, route, itemId, grok: forGrokNow ? "queued" : null,
        queuedAt: forGrokNow ? pending?.queuedAt ?? store.now() : null, cost: result.cost,
      });
      store.markTriaged(ids);
    });
    if (route === "skip") updateSkipped();
    return urgent;
  }

  /**
   * Messages that showed up long after they were sent (history read when a source was first linked),
   * or that arrived before triage was on, are filed without a decision. Messages delayed by an
   * OpenRouter outage are not: they arrived on time and still get decided.
   */
  function stale(m: InboxMessage, now: number, onSince: number) {
    return now - m.at > STALE_MS && (m.receivedAt - m.at > STALE_MS || m.receivedAt < onSince - STALE_MS);
  }

  async function run() {
    const now = store.now();
    const expired = store.expireGrokClaims(now - CLAIM_LEASE_MS, MAX_HANDOUTS);
    if (expired.requeued || expired.failed) log(`Grok didn't confirm ${expired.requeued + expired.failed} chat(s): ${expired.requeued} queued again, ${expired.failed} left to you`);
    const onSince = Number(store.getState("triage:onSince") ?? now);
    const groups = new Map<string, InboxMessage[]>();
    for (const m of store.untriaged(2000)) {
      const k = `${m.source}\n${m.thread}`;
      groups.set(k, [...(groups.get(k) ?? []), m]);
    }
    let done = 0;
    let urgent = 0;
    for (let msgs of groups.values()) {
      const old = msgs.filter((m) => stale(m, now, onSince));
      if (old.length) store.markTriaged(old.map((m) => m.id));
      msgs = msgs.filter((m) => !old.includes(m));
      if (!msgs.length) continue;
      const newest = msgs.at(-1)!.at;
      const oldest = msgs[0].receivedAt;
      if (now - newest < QUIET_MS && now - oldest < MAX_WAIT_MS && !msgs.at(-1)!.fromMe) continue;
      if (done++ >= GROUPS_PER_RUN) break;
      urgent += await handle(msgs);
    }
    if (active()) await phone(urgent);
  }

  return {
    on,
    active,
    tick() {
      // When triage started deciding: messages that arrived before then are not decided late.
      if (!on()) store.setState("triage:onSince", null);
      else if (!store.getState("triage:onSince")) store.setState("triage:onSince", String(store.now()));
      if (!on() || running || store.now() < retryAt) return running ?? Promise.resolve();
      running = run()
        .then(() => {
          if (error) log("triage works again");
          error = "";
        })
        .catch((err) => {
          const msg = (err as Error).message;
          if (msg !== error) log(`triage: ${msg}`);
          error = msg;
          // OpenRouter trouble: try again in 2 minutes. A bad key or no credit: in 15.
          retryAt = store.now() + (err instanceof JevError && err.retry ? 2 : 15) * 60_000;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
    wakeDue() {
      if (!active()) return false;
      const now = store.now();
      const grok = bot();
      const cooldown = settings.int("wakeCooldown") * 60_000;
      if (now - lastAttempt < cooldown) return false;
      if (store.wakesSince(now - cooldown, grok).length) return false;
      if (store.wakesSince(dayStart(), grok).length >= settings.int("wakeCeiling")) return false;
      const queue = store.grokQueue();
      if (!queue.length) return false;
      // A wake that Grok never answered isn't repeated for the same chats: only a new decision wakes it
      // again. Unanswered chats go along with that wake, a tap, or Refresh.
      const lastWake = Math.max(lastAttempt, store.wakesSince(0, grok).filter((w) => w.reason === "inbox").at(-1)?.at ?? 0);
      if (!queue.some((t) => t.decidedAt > lastWake || (t.attempts > 0 && (t.queuedAt ?? 0) > lastWake))) return false;
      const waitedSince = (t: TriageRow) => t.queuedAt ?? t.decidedAt;
      const today = queue.filter((t) => t.level >= TODAY);
      return (
        queue.some((t) => t.level >= NOW) ||
        today.length >= settings.int("wakeBatch") ||
        (today.length > 0 && now - Math.min(...today.map(waitedSince)) >= settings.int("wakeBatchHours") * 3_600_000) ||
        now - Math.min(...queue.map(waitedSince)) >= MAX_QUEUE_AGE_MS
      );
    },
    woke() {
      lastAttempt = store.now();
    },
    claimForGrok() {
      return store.claimGrokQueue().map((t) => {
        const m = store.threadMessages(t.source, t.thread, 1)[0];
        const info = m ? deps.sourceInfo(m) : { label: t.source, app: "", where: "" };
        return forGrok(store, t, info, tz);
      });
    },
    ack(key) {
      // Handed-out chats, and ones queued again after their lease ran out, are done once Grok writes the card.
      const handedOut = [...store.sentToGrok(), ...store.grokQueue().filter((t) => t.attempts > 0)];
      for (const t of handedOut) if (cardKey(t.source, t.thread, "needs") === key) store.setGrok(t.id, "done");
    },
    waiting: () => store.grokQueue().length,
    runsToday() {
      return store.wakesSince(dayStart(), bot()).length;
    },
    status() {
      if (!on()) {
        return [
          { group: "Triage", on: false, ok: true, text: "Off" },
          { group: "Grok wakes", on: false, ok: true, text: "Off while triage is off" },
          { group: "Phone pings", on: false, ok: true, text: "Off" },
        ];
      }
      const today = store.triageSince(dayStart()).filter((t) => t.route !== "replied");
      const cents = today.reduce((s, t) => s + t.cost, 0) * 100;
      const waiting = store.grokQueue().length;
      const sorted = `${today.length} chat${today.length === 1 ? "" : "s"} sorted today for ${cents < 0.1 && cents > 0 ? "under 0.1" : cents.toFixed(1)}¢`;
      if (!active()) {
        const count = (r: string) => today.filter((t) => t.route === r).length;
        const would = `Would have: ${count("wake")} Grok wakes, ${count("ride")} queued for Grok, ${count("card")} cards, ${count("catchup")} catch-up lines, ${count("skip")} filtered`;
        return [
          error ? { group: "Triage", on: true, ok: false, text: error } : { group: "Triage", on: true, ok: true, text: `Shadow: ${sorted}. ${would}.` },
          { group: "Grok wakes", on: false, ok: true, text: "Grok keeps its schedule while triage is in shadow mode" },
          { group: "Phone pings", on: false, ok: true, text: "Off in shadow mode" },
        ];
      }
      return [
        error ? { group: "Triage", on: true, ok: false, text: error } : { group: "Triage", on: true, ok: true, text: sorted },
        { group: "Grok wakes", on: true, ok: true, text: `${store.wakesSince(dayStart(), bot()).length} Grok runs today, ${waiting} chat${waiting === 1 ? "" : "s"} waiting for Grok` },
        settings.str("ntfyTopic")
          ? { group: "Phone pings", on: true, ok: true, text: lastPing ? `Last ping ${localStamp(new Date(lastPing), tz).slice(11, 16)}` : "No ping yet" }
          : { group: "Phone pings", on: false, ok: true, text: "Off" },
      ];
    },
  };
}
