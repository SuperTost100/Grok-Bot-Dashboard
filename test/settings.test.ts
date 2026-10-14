import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { Settings } from "../server/settings.ts";
import { loadConfig } from "../server/config.ts";

const OWNER = "owner@example.com";
const env = { OWNER_LOGIN: OWNER, BOT_TOKEN: "test-token-123", TZ: "Europe/Rome", UNDO_SECONDS: "8", TODOIST_TOKEN: "from-env" };

async function start() {
  const config = { ...loadConfig(env), publicDir: new URL("../public", import.meta.url).pathname.replace(/\/$/, "") };
  const store = new Store(":memory:");
  const settings = new Settings(store, config, env);
  const changes: string[][] = [];
  settings.onChange((keys) => changes.push(keys));
  const server = http.createServer(createApp({ config, store, settings, log: () => {} }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, who = OWNER) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Tailscale-User-Login": who, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const one = async (key: string) => (await call("GET", "/api/ui/settings")).body.settings.find((s: { key: string }) => s.key === key);
  const stop = () => { server.closeAllConnections(); server.close(); store.close(); };
  return { store, settings, call, one, changes, stop };
}

test("settings start from .env, a page value wins, and reset goes back to .env", async () => {
  const t = await start();
  try {
    assert.deepEqual([(await t.one("undoSeconds")).value, (await t.one("undoSeconds")).source], [8, "env"]);
    assert.deepEqual([(await t.one("archiveDays")).value, (await t.one("archiveDays")).source], [30, "default"]);

    assert.equal((await t.call("PUT", "/api/ui/settings", { values: { undoSeconds: 12 } })).status, 200);
    assert.deepEqual([(await t.one("undoSeconds")).value, (await t.one("undoSeconds")).source], [12, "page"]);
    assert.equal((await t.call("GET", "/api/ui/state")).body.undoSeconds, 12, "the page and the bots see the new value");

    await t.call("PUT", "/api/ui/settings", { values: { undoSeconds: null } });
    assert.deepEqual([(await t.one("undoSeconds")).value, (await t.one("undoSeconds")).source], [8, "env"]);
    assert.deepEqual(t.changes, [["undoSeconds"], ["undoSeconds"]]);
  } finally {
    t.stop();
  }
});

test("bad values are refused and nothing in the same save is kept", async () => {
  const t = await start();
  try {
    const res = await t.call("PUT", "/api/ui/settings", { values: { archiveDays: 60, undoSeconds: 99 } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Undo window must be a whole number from 0 to 60/);
    assert.equal((await t.one("archiveDays")).value, 30);
    assert.equal((await t.call("PUT", "/api/ui/settings", { values: { areadidatticaUrl: "ftp://x" } })).status, 400);
    assert.equal((await t.call("PUT", "/api/ui/settings", { values: { nope: 1 } })).status, 400);
    assert.equal((await t.call("PUT", "/api/ui/settings", { values: { undoSeconds: 1 } }, "someone@else.com")).status, 403);
  } finally {
    t.stop();
  }
});

test("secrets are write-only: the page only learns whether one is set", async () => {
  const t = await start();
  try {
    const before = await t.one("todoistToken");
    assert.deepEqual([before.value, before.set, before.source], [null, true, "env"]);
    const res = await t.call("PUT", "/api/ui/settings", { values: { todoistToken: "new-secret" } });
    assert.ok(!JSON.stringify(res.body).includes("new-secret"), "the answer never echoes the secret");
    assert.ok(!JSON.stringify((await t.call("GET", "/api/ui/settings")).body).includes("from-env"));
    assert.equal(t.settings.str("todoistToken"), "new-secret");
    const off = await t.one("areadidatticaToken");
    assert.deepEqual([off.set, off.source], [false, "default"]);
  } finally {
    t.stop();
  }
});

test("saving the same value again doesn't count as a change", async () => {
  const t = await start();
  try {
    await t.call("PUT", "/api/ui/settings", { values: { archiveDays: 30 } });
    assert.deepEqual(t.changes, []);
    assert.equal((await t.one("archiveDays")).source, "page");
  } finally {
    t.stop();
  }
});
