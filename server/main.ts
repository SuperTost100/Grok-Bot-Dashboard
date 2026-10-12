import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { Todoist } from "./todoist.ts";
import { createApp, STALE_CLAIM_MS } from "./app.ts";
import { checkWebhookUrl, guardedLookup, retryDue, RETRY_WINDOW } from "./webhook.ts";
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
const todoist = config.todoistToken ? new Todoist(config.todoistToken, config.todoistFilter, config.tz) : null;

// Ping a bot's webhook routine so it picks up work now instead of at its next scheduled run.
// At most one ping per bot every 20 seconds; a ping that comes sooner is sent when the gap is up.
// Unclaimed actions and unanswered refreshes get one retry (see retryDue); after that the bot's scheduled run does it.
const PING_GAP = 20_000;
const lastPing = new Map<string, { at: number; ok: boolean }>();
const deferred = new Map<string, NodeJS.Timeout>();

function notify(slug: string, reason: "actions" | "refresh") {
  const wait = (lastPing.get(slug)?.at ?? 0) + PING_GAP - Date.now();
  if (wait <= 0) return void ping(slug, reason);
  if (deferred.has(slug)) return;
  deferred.set(slug, setTimeout(() => { deferred.delete(slug); void ping(slug, reason); }, wait));
}

async function ping(slug: string, reason: "actions" | "refresh") {
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
          : "Someone pressed refresh on the dashboard. Scan your sources and update it.",
    });
    sent.ok = status >= 200 && status < 300;
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

const handle = createApp({ config, store, todoist, notify, lastPing: (bot) => lastPing.get(bot), log });
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log(`unhandled error on ${req.method} ${req.url}: ${(err as Error).stack}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Something broke on the server. Check its logs." }));
  });
});
process.on("unhandledRejection", (err) => log(`unhandled rejection: ${(err as Error)?.stack ?? err}`));

const tick = setInterval(() => {
  try {
    store.wakeSnoozed();
    store.expireClaims(STALE_CLAIM_MS);
    for (const bot of store.promoteDue()) notify(bot, "actions");
    for (const bot of store.botsWithReadyWork(RETRY_WINDOW)) {
      if (retryDue(lastPing.get(bot), Date.now())) notify(bot, "actions");
    }
    for (const bot of store.botsWithPendingRefresh(RETRY_WINDOW)) {
      if (retryDue(lastPing.get(bot), Date.now())) notify(bot, "refresh");
    }
  } catch (err) {
    log(`tick failed: ${(err as Error).message}`);
  }
}, 1000);

// One consistent backup a day in DATA_DIR/backups, keeping BACKUP_DAYS of them.
async function dailyBackup() {
  if (!config.backupDays) return;
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
  const old = fs.readdirSync(dir).filter((f) => /^dashboard-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -config.backupDays);
  for (const f of old) fs.rmSync(path.join(dir, f));
}

const housekeeping = setInterval(() => {
  store.purge(config.archiveDays);
  void dailyBackup();
}, 3600_000);
store.purge(config.archiveDays);
void dailyBackup();

server.listen(config.port, config.host, () => {
  log(`Grok Bot Dashboard on http://${config.host}:${config.port} (auth: ${config.authMode}, to-dos: ${todoist ? "Todoist" : "from bots"}, time zone: ${config.tz})`);
});

function shutdown() {
  clearInterval(tick);
  clearInterval(housekeeping);
  for (const t of deferred.values()) clearTimeout(t);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
