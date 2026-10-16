import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { createApp, CALENDAR_OWNER, POLITO_BOT, STALE_CLAIM_MS, type AppDeps } from "./app.ts";
import { Settings } from "./settings.ts";
import { createTriage } from "./triage.ts";
import { createPhone } from "./ntfy.ts";
import { createAddons } from "./addons/manager.ts";
import { createRunnerClient } from "./addons/runner-client.ts";
import { answeredAt, dueAt, handoffWork, lastWakeOf, rules, wakeMessage } from "./wakes.ts";
import type { InboxMessage } from "./store.ts";
import { checkWebhookUrl, guardedLookup, missedRun, retryDue, RETRY_WINDOW } from "./webhook.ts";
import { localStamp } from "./time.ts";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const config = loadConfig();

// The database holds webhook keys and your messages' summaries: keep it readable by this user only.
process.umask(0o077);
fs.mkdirSync(config.dataDir, { recursive: true });
try {
  fs.chmodSync(config.dataDir, 0o700);
} catch {
  log(`could not restrict permissions on ${config.dataDir}`);
}
const store = new Store(path.join(config.dataDir, "dashboard.db"));
const settings = new Settings(store, config);

/** How a message's source is named on cards and described to Jev. */
function sourceInfo(m: InboxMessage) {
  // Sources an add-on or app described when it sent its messages.
  const described = store.getState(`inbox:source:${m.source}`);
  if (described) {
    const d = JSON.parse(described) as { name: string; app: string; kind: "chat" | "mail" };
    if (d.kind === "mail") return { label: `${d.name} · ${m.fromMe ? "You" : m.sender}`, app: d.app || "mail", where: `Email to the user's ${d.name} mailbox` };
    return { label: `${d.name} · ${m.threadName}`, app: d.app, where: m.isGroup ? `${d.name} group chat "${m.threadName}"` : `${d.name} chat with ${m.threadName}` };
  }
  return { label: `${m.source} · ${m.threadName || m.sender}`, app: "", where: `a ${m.isGroup ? "group chat" : "conversation"} from ${m.source}` };
}
const triage = createTriage({ store, settings, tz: config.tz, log, sourceInfo });
const phone = createPhone({ store, settings, tz: config.tz, log });

// Ping a bot's webhook routine so it picks up work now instead of at its next scheduled run.
// At most one ping per bot every 20 seconds; a ping that comes sooner is sent when the gap is up.
// Unclaimed actions and unanswered refreshes get one retry (see retryDue); after that the bot's scheduled run does it.
const PING_GAP = 20_000;
const lastPing = new Map<string, { at: number; ok: boolean }>();
const woken = new Map<string, number>(); // the missed scheduled run each bot was last woken for
const attempted = new Map<string, number>(); // when each bot was last woken for handoffs, before its ping lands
// A bot that took handoffs and never reported them gets them again after this long (twice at most).
const HANDOFF_LEASE_MS = 30 * 60_000;
const deferred = new Map<string, NodeJS.Timeout>();

type Reason = "actions" | "refresh" | "inbox" | "work";

function notify(slug: string, reason: Reason) {
  const wait = (lastPing.get(slug)?.at ?? 0) + PING_GAP - Date.now();
  if (wait <= 0) return void ping(slug, reason);
  if (deferred.has(slug)) return;
  deferred.set(slug, setTimeout(() => { deferred.delete(slug); void ping(slug, reason); }, wait));
}

async function ping(slug: string, reason: Reason) {
  const bot = store.getBot(slug);
  if (!bot?.webhookUrl) return;
  const sent = { at: Date.now(), ok: false };
  lastPing.set(slug, sent);
  try {
    const status = await post(bot.webhookUrl, bot.webhookToken, {
      source: "grok-bot-dashboard",
      reason,
      message:
        reason === "actions"
          ? "You have dashboard actions waiting. Run: grokdash actions"
          : reason === "inbox" || reason === "work"
            ? wakeMessage(store, slug, slug === settings.str("grokBot") && triage.active() ? store.grokQueue().length : 0)
            : "Someone pressed refresh on the dashboard. Scan your sources and update it.",
    });
    sent.ok = status >= 200 && status < 300;
    // Every accepted ping starts a paid Grok run: the footer and the daily ceiling count them.
    if (sent.ok) store.addWake(reason, slug);
    log(`webhook ${slug} (${reason}): ${status}`);
  } catch (err) {
    log(`webhook ${slug} (${reason}) failed: ${(err as Error).message}`);
  }
}

/** POST without following redirects, connecting only to an address that passed the private-network check. */
function post(url: string, token: string, body: unknown): Promise<number> {
  const problem = checkWebhookUrl(url, config.webhookAllowPrivate);
  if (problem) return Promise.reject(new Error(problem));
  const data = JSON.stringify(body);
  const u = new URL(url);
  const client = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      u,
      {
        method: "POST",
        lookup: guardedLookup(config.webhookAllowPrivate) as never,
        timeout: 10_000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out after 10 s")));
    req.on("error", reject);
    req.end(data);
  });
}

// Apps need the runner service (compose.yaml). Without RUNNER_URL, add-ons still work and apps say why they can't start.
const runnerUrl = process.env.RUNNER_URL ?? "";
const addons = createAddons({
  store, dataDir: config.dataDir, tz: config.tz, log,
  localUrl: `http://127.0.0.1:${config.port}`,
  appUrl: process.env.DASHBOARD_URL_FOR_APPS ?? "http://dashboard:8787",
  runner: runnerUrl ? createRunnerClient(runnerUrl, process.env.RUNNER_KEY_FILE ?? "/run/runner/runner.key") : null,
  untrustedSafe: config.ownerVia === "gateway" && config.authMode === "tailscale",
  reserved: () => [settings.str("grokBot")],
  // The dashboard's own readers: only a trusted add-on may carry their cards and events on.
  integrations: [POLITO_BOT, CALENDAR_OWNER, "todoist", "mail", "whatsapp"],
});
const deps: AppDeps = { config, store, settings, triage, phone, addons, notify, lastPing: (bot) => lastPing.get(bot), log };
const handle = createApp(deps);
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log(`unhandled error on ${req.method} ${req.url}: ${(err as Error).stack}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Something broke on the server. Check its logs." }));
  });
});
process.on("unhandledRejection", (err) => log(`unhandled rejection: ${(err as Error)?.stack ?? err}`));

let ticks = 0;
const tick = setInterval(() => {
  try {
    // A snoozed card coming back is a reminder you set: the phone gets told.
    const back = store.wakeSnoozed();
    if (back) void phone.ping("reminder", back);
    store.expireClaims(STALE_CLAIM_MS);
    for (const bot of store.promoteDue()) notify(bot, "actions");
    for (const bot of store.botsWithReadyWork(RETRY_WINDOW)) {
      if (retryDue(lastPing.get(bot), Date.now())) notify(bot, "actions");
    }
    for (const bot of store.botsWithPendingRefresh(RETRY_WINDOW)) {
      if (retryDue(lastPing.get(bot), Date.now())) notify(bot, "refresh");
    }
    for (const b of store.listBots()) {
      // With triage on, the Grok bot has no schedule to miss: it runs when triage or a tap wakes it.
      const unscheduled = triage.active() && b.slug === settings.str("grokBot");
      const run = b.webhookUrl && !unscheduled ? missedRun(b, Date.now(), config.tz) : null;
      if (run === null || woken.get(b.slug) === run) continue;
      woken.set(b.slug, run);
      log(`${b.slug} missed its ${localStamp(new Date(run), config.tz).slice(11, 16)} run, waking it`);
      store.requestRefresh(b.slug);
      notify(b.slug, "refresh");
    }
    if (++ticks % 5 === 0) void triage.tick();
    if (ticks % 60 === 0) {
      void phone.tick();
      store.expireHandoffClaims(Date.now() - HANDOFF_LEASE_MS);
    }
    // Handoffs wake their receiver on the same rules as triage. The Grok bot's are part of its triage wake.
    for (const slug of store.botsWithHandoffs()) {
      if (slug === settings.str("grokBot") && triage.active()) continue;
      if (!store.getBot(slug)?.webhookUrl) continue;
      const due = dueAt(handoffWork(store, slug), lastWakeOf(store, slug, attempted.get(slug)), answeredAt(store, slug), rules(store, settings, config.tz));
      if (due === null || due > Date.now()) continue;
      attempted.set(slug, Date.now());
      log(`waking ${slug} for ${store.queuedHandoffs(slug).length} handoff(s)`);
      notify(slug, "work");
    }
    if (triage.wakeDue()) {
      triage.woke();
      const grok = settings.str("grokBot");
      log(`waking ${grok} for ${store.grokQueue().length} waiting chat(s)`);
      notify(grok, "inbox");
    }
  } catch (err) {
    log(`tick failed: ${(err as Error).message}`);
  }
}, 1000);

// One consistent backup a day in DATA_DIR/backups, keeping BACKUP_DAYS of them.
async function dailyBackup() {
  const keep = settings.int("backupDays");
  if (!keep) return;
  const dir = path.join(config.dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dashboard-${localStamp(new Date(), config.tz).slice(0, 10)}.db`);
  if (!fs.existsSync(file)) {
    try {
      await store.backupTo(file);
      log(`backup written: ${file}`);
    } catch (err) {
      log(`backup failed: ${(err as Error).message}`);
    }
  }
  const old = fs.readdirSync(dir).filter((f) => /^dashboard-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
}

// Message text read from WhatsApp and mail is only kept while it can still matter.
const INBOX_DAYS = 14;

const housekeeping = setInterval(() => {
  void addons.checkUpdates();
  store.purge(settings.int("archiveDays"));
  store.purgeInbox(INBOX_DAYS);
  void dailyBackup();
}, 3600_000);
store.purge(settings.int("archiveDays"));
void dailyBackup();

server.listen(config.port, config.host, () => {
  // Add-ons call the dashboard over HTTP, so they start once it listens.
  void addons.startAll();
  log(`Grok Bot Dashboard on http://${config.host}:${config.port} (auth: ${config.authMode}, add-ons: ${store.listAddons().filter((a) => a.enabled).length}, time zone: ${config.tz})`);
});

async function shutdown() {
  clearInterval(tick);
  clearInterval(housekeeping);
  for (const t of deferred.values()) clearTimeout(t);
  // Add-on processes go first, while the database can still revoke their tokens.
  setTimeout(() => process.exit(0), 8000).unref();
  await addons.stopAll().catch(() => {});
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
