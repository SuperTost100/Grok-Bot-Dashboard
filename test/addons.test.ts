import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { filesUnder } from "../server/addons/tar.ts";
import { parseManifest, checkSettings } from "../server/addons/manifest.ts";
import { createAddons } from "../server/addons/manager.ts";
import { GitHub, parseRepoRef } from "../server/addons/github.ts";
import { checkCompose, fillVars } from "../runner/validate.mjs";

/** A .tar.gz shaped like GitHub's archives: everything under one "owner-repo-sha/" folder. */
function tarGz(files: Record<string, string>, top = "owner-store-abc1234"): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const head = Buffer.alloc(512);
    head.write(`${top}/${name}`, 0, 100);
    head.write("0000644\0", 100);
    head.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    head.write("0", 156);
    head.write("ustar\0" + "00", 257);
    blocks.push(head, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test("tar: only the folder asked for, and nothing that climbs out of it", () => {
  const files = filesUnder(tarGz({ "store.json": "{}", "addons/a/addon.json": "{}", "addons/a/lib/x.js": "1", "addons/b/addon.json": "{}" }), "addons/a");
  assert.deepEqual([...files.keys()].sort(), ["addon.json", "lib/x.js"]);
  assert.throws(() => filesUnder(tarGz({ "addons/a/../../etc/passwd": "x" }), "addons/a"), /outside/);
});

test("manifest: checked before anything runs, and settings keep saved secrets", () => {
  assert.throws(() => parseManifest({ id: "Bad Id", name: "x", type: "addon", entry: "a.js" }), /lowercase/);
  assert.throws(() => parseManifest({ id: "x1", name: "x", type: "addon" }), /entry/);
  assert.throws(() => parseManifest({ id: "x1", name: "x", type: "addon", entry: "../a.js" }), /inside/);
  assert.throws(() => parseManifest({ id: "x1", name: "x", type: "addon", entry: "a.js", asks: ["root"] }), /isn't one of/);
  const m = parseManifest({ id: "mail", name: "Mail", type: "addon", entry: "index.js", asks: ["triage"], settings: [{ key: "host", label: "Host", required: true }, { key: "password", label: "Password", type: "secret" }, { key: "every", label: "Every", type: "number", default: 5 }] });
  assert.throws(() => checkSettings(m.settings, {}), /Host is needed/);
  assert.deepEqual(checkSettings(m.settings, { host: "imap.x", password: "" }, { password: "old" }), { host: "imap.x", password: "old", every: 5 });
});

test("store links: owner/repo, a repo link, or a folder in one", () => {
  assert.deepEqual(parseRepoRef("SuperTost100/grokdash-store"), { repo: "SuperTost100/grokdash-store", branch: "", path: "" });
  assert.deepEqual(parseRepoRef("https://github.com/a/b/tree/main/addons/mail"), { repo: "a/b", branch: "main", path: "addons/mail" });
  assert.throws(() => parseRepoRef("https://evil.example/a/b"), /Not a GitHub/);
});

test("runner rules: nothing privileged, no host folders or ports, the token only where asked", () => {
  const o = { id: "wa", network: "grokdash", env: { DASH_TOKEN: "t" } };
  const bad = (svc: Record<string, unknown>, extra: Record<string, unknown> = {}) => () => checkCompose({ services: { s: { image: "x", ...svc } }, ...extra }, o);
  assert.throws(bad({ privileged: true }), /can't set "privileged"/);
  assert.throws(bad({ network_mode: "host" }), /network_mode/);
  assert.throws(bad({ ports: ["80:80"] }), /ports/);
  assert.throws(bad({ volumes: ["/var/run/docker.sock:/s"] }), /named volumes/);
  assert.throws(bad({ volumes: ["./data:/d"] }), /named volumes/);
  assert.throws(bad({ user: "root" }), /root/);
  assert.throws(bad({ build: "/etc" }), /own folder/);
  assert.throws(bad({}, { networks: { x: {} } }), /can't set "networks"/);
  assert.throws(bad({ volumes: ["v:/d"] }, { volumes: { v: { driver_opts: { type: "none", device: "/" } } } }), /driver/);
  const ok = checkCompose({ services: { waha: { image: "devlikeapro/waha", volumes: ["s:/data"] }, glue: { build: ".", "x-dashboard": true } }, volumes: { s: {} } }, o);
  assert.deepEqual(ok.services.waha.environment, {}, "a third-party image never sees the token");
  assert.equal((ok.services.glue.environment as Record<string, string>).DASH_TOKEN, "t");
  assert.deepEqual(ok.services.glue.networks, ["dashboard"]);
  assert.equal(fillVars("${SETTING_A} costs $5", { SETTING_A: "x$" }), "x$$ costs $$5");
});

// ---------- A real add-on, installed from a fake store and run as its own process ----------

const ADDON = `
const base = process.env.DASH_URL, token = process.env.DASH_TOKEN;
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return res.status;
};
const settings = JSON.parse(process.env.ADDON_SETTINGS);
await call("POST", "/api/bot/items", { key: "hello", kind: "reminder", title: "Hello " + settings.name, bot: "someone-else" });
await call("PUT", "/api/bot/panel", { title: "Parcels", blocks: [{ type: "text", text: "2 on the way" }] });
const read = await call("GET", "/api/addon/messages");
const env = Object.keys(process.env).filter((k) => !["DASH_URL","DASH_TOKEN","ADDON_ID","ADDON_DATA","ADDON_SETTINGS","TZ","NODE_ENV"].includes(k));
let etc = "blocked";
try { (await import("node:fs")).readFileSync("/etc/hostname"); etc = "open"; } catch {}
await call("PUT", "/api/addon/status", { text: "read=" + read + " env=" + env.join(",") + " etc=" + etc });
setInterval(() => {}, 1000);
`;

test("add-ons: install from a store, run locked down, trust changes what they reach, removal closes their cards", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gbd-addons-"));
  const store = new Store(":memory:");
  const config = loadConfig({ OWNER_LOGIN: "o@x.com", BOT_TOKEN: "test-token-123", TZ: "Europe/Rome", DATA_DIR: dataDir });
  const files = {
    "store.json": JSON.stringify({ items: [{ id: "parcels", name: "Parcels", type: "addon", path: "addons/parcels", description: "Where your parcels are" }] }),
    "addons/parcels/addon.json": JSON.stringify({ id: "parcels", name: "Parcels", type: "addon", entry: "index.mjs", asks: ["messages"], settings: [{ key: "name", label: "Name", required: true }] }),
    "addons/parcels/index.mjs": ADDON,
  };
  const sha = "abc1234def";
  const fake = (async (input: URL | RequestInfo) => {
    const url = String(input);
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url.endsWith("/repos/owner/store")) return json({ default_branch: "main" });
    if (url.includes("/repos/owner/store/commits")) return json([{ sha, commit: { message: "Add parcels", committer: { date: "2026-10-16T00:00:00Z" } } }]);
    if (url === `https://raw.githubusercontent.com/owner/store/${sha}/store.json`) return new Response(files["store.json"]);
    if (url === `https://raw.githubusercontent.com/owner/store/${sha}/addons/parcels/addon.json`) return new Response(files["addons/parcels/addon.json"]);
    if (url === `https://codeload.github.com/owner/store/tar.gz/${sha}`) return new Response(new Uint8Array(tarGz(files)));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const addons = createAddons({ store, dataDir, localUrl: base, appUrl: base, tz: "Europe/Rome", log: () => {}, github: new GitHub(fake) });
  server.on("request", createApp({ config: { ...config, authMode: "none" }, store, addons, log: () => {} }));
  const ui = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const until = async (fn: () => boolean, what: string) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fn(), what);
  };
  try {
    addons.setStores(["owner/store"]);
    const cat = (await ui("GET", "/api/ui/addons/catalog")).body;
    assert.deepEqual(cat.entries.map((e: { id: string; installed: boolean }) => [e.id, e.installed]), [["parcels", false]]);
    assert.deepEqual((await ui("GET", "/api/ui/addons/peek?source=owner/store/addons/parcels")).body.asks, ["messages"]);
    assert.equal((await ui("POST", "/api/ui/addons/install", { source: "https://github.com/owner/store/tree/main/addons/parcels", settings: {} })).status, 400, "a required setting is missing");
    assert.equal((await ui("POST", "/api/ui/addons/install", { source: "https://github.com/owner/store/tree/main/addons/parcels", settings: { name: "Tost" } })).status, 200);
    await until(() => store.getAddon("parcels")!.status.startsWith("read="), "the add-on reported its status");
    const card = store.getItemByKey("parcels", "hello")!;
    assert.equal(card.title, "Hello Tost", "it posted as itself, whatever it claimed");
    assert.equal(store.getPanel("parcels")!.title, "Parcels");
    assert.equal(store.getAddon("parcels")!.status, "read=403 env= etc=blocked", "untrusted: no messages; no dashboard environment; no files outside its folder");
    assert.equal(store.getBot("parcels")!.kind, "addon");

    // You close its card: it hears about it as a "closed" action.
    await ui("POST", `/api/ui/items/${card.id}/act`, { type: "dismiss" });
    store.promoteDue("parcels");
    assert.equal(store.claimActions("parcels")[0]?.type, "closed");

    // Trusted, it restarts with a new token and may read messages.
    const oldHash = store.getAddon("parcels")!.tokenHash;
    assert.equal((await ui("PUT", "/api/ui/addons/parcels", { trusted: true })).status, 200);
    await until(() => store.getAddon("parcels")!.tokenHash !== oldHash && store.getAddon("parcels")!.status.startsWith("read=200"), "trusted add-on reads messages");
    const view = (await ui("GET", "/api/ui/addons")).body.installed[0];
    assert.deepEqual([view.trusted, view.running, view.settings[0].value], [true, true, "Tost"]);

    // Removal stops it, kills its token and closes its open cards.
    await store.upsertItem({ bot: "parcels", key: "open-one", section: "needs", kind: "reminder", title: "Parcel at the locker" });
    assert.equal((await ui("DELETE", "/api/ui/addons/parcels", {})).status, 200);
    assert.equal(store.getAddon("parcels"), null);
    assert.equal(store.getItemByKey("parcels", "open-one")!.status, "closed");
  } finally {
    await addons.stopAll();
    server.closeAllConnections();
    server.close();
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
