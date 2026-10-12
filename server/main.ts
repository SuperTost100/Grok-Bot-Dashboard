import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { Todoist } from "./todoist.ts";
import { createApp } from "./app.ts";

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const store = new Store(path.join(config.dataDir, "dashboard.db"));
const todoist = config.todoistToken ? new Todoist(config.todoistToken, config.todoistFilter) : null;
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

// Ping a bot's webhook automation so it picks up work now instead of at its next scheduled run.
// At most one ping per bot every 20 seconds. A ping that comes sooner is sent when the 20 seconds
// are up, so a second tap isn't left waiting for the bot's next scheduled run.
const PING_GAP = 20_000;
const lastPing = new Map<string, number>();
const deferred = new Map<string, NodeJS.Timeout>();
function notify(slug: string, reason: "actions" | "refresh") {
  const wait = (lastPing.get(slug) ?? 0) + PING_GAP - Date.now();
  if (wait <= 0) return void ping(slug, reason);
  if (deferred.has(slug)) return;
  deferred.set(slug, setTimeout(() => { deferred.delete(slug); void ping(slug, reason); }, wait));
}

async function ping(slug: string, reason: "actions" | "refresh") {
  const bot = store.getBot(slug);
  if (!bot?.webhookUrl) return;
  lastPing.set(slug, Date.now());
  try {
    const res = await fetch(bot.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bot.webhookToken ? { Authorization: `Bearer ${bot.webhookToken}` } : {}),
      },
      body: JSON.stringify({
        source: "grok-bot-dashboard",
        reason,
        message:
          reason === "actions"
            ? "You have dashboard actions waiting. Run: grokdash actions"
            : "Someone pressed refresh on the dashboard. Scan your sources and update it.",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    log(`webhook ${slug} (${reason}): ${res.status}`);
  } catch (err) {
    log(`webhook ${slug} (${reason}) failed: ${(err as Error).message}`);
  }
}

const handle = createApp({ config, store, todoist, notify, log });
const server = http.createServer(handle);

const tick = setInterval(() => {
  try {
    store.wakeSnoozed();
    for (const bot of store.promoteDue()) void notify(bot, "actions");
  } catch (err) {
    log(`tick failed: ${(err as Error).message}`);
  }
}, 1000);

const daily = setInterval(() => store.purge(config.archiveDays), 6 * 3600_000);
store.purge(config.archiveDays);

server.listen(config.port, config.host, () => {
  log(`Grok Bot Dashboard on http://${config.host}:${config.port} (auth: ${config.authMode}, to-dos: ${todoist ? "Todoist" : "from bots"})`);
});

function shutdown() {
  clearInterval(tick);
  clearInterval(daily);
  for (const t of deferred.values()) clearTimeout(t);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
