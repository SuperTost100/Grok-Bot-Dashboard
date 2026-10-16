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
  const bad = (svc: Record<string, unknown>, extra: Record<string, unknown> = {}) => () => checkCompose({ services: { "wa-s": { image: "x", ...svc } }, ...extra }, o);
  assert.throws(() => checkCompose({ services: { dashboard: { image: "x" } } }, o), /must be named "wa"/, "can't answer for the dashboard's name");
  assert.throws(bad({ privileged: true }), /can't set "privileged"/);
  assert.throws(bad({ network_mode: "host" }), /network_mode/);
  assert.throws(bad({ ports: ["80:80"] }), /ports/);
  assert.throws(bad({ volumes: ["/var/run/docker.sock:/s"] }), /named volumes/);
  assert.throws(bad({ volumes: ["./data:/d"] }), /named volumes/);
  assert.throws(bad({ user: "root" }), /root/);
  assert.throws(bad({ build: "/etc" }), /own folder/);
  assert.throws(bad({}, { networks: { x: {} } }), /can't set "networks"/);
  assert.throws(bad({ volumes: ["v:/d"] }, { volumes: { v: { driver_opts: { type: "none", device: "/" } } } }), /driver/);
  const ok = checkCompose({ services: { "wa-waha": { image: "devlikeapro/waha", volumes: ["s:/data"] }, "wa-glue": { build: ".", "x-dashboard": true } }, volumes: { s: {} } }, o);
  assert.deepEqual(ok.services["wa-waha"].environment, {}, "a third-party image never sees the token");
  assert.equal((ok.services["wa-glue"].environment as Record<string, string>).DASH_TOKEN, "t");
  assert.deepEqual(ok.services["wa-glue"].networks, ["dashboard"]);
  assert.equal(fillVars("${SETTING_A} costs $5, $$HOME", { SETTING_A: "x$" }), "x$$ costs $$5, $$HOME");
  assert.equal(fillVars("${DASH_TOKEN}", { DASH_TOKEN: "t" }), "$${DASH_TOKEN}", "the token is never a placeholder");
  assert.throws(bad({ environment: { BOT_TOKEN: null } }), /needs a value/, "nothing inherited from the runner");
  assert.throws(bad({ environment: ["BOT_TOKEN"] }), /NAME=value/);
  assert.throws(bad({ build: { context: ".", args: ["BOT_TOKEN"] } }), /NAME=value/);
  assert.throws(bad({ build: { context: "./..", dockerfile: "x" } }), /own folder/);
  assert.throws(bad({ build: { context: ".", dockerfile: "/proc/self/environ" } }), /file name inside/);
  const tagged = checkCompose({ services: { "wa-x": { build: ".", image: "grok-bot-dashboard-runner" } } }, o);
  assert.equal(tagged.services["wa-x"].image, "gd-wa-wa-x:latest", "a build can't overwrite another image");
});

// ---------- A real add-on, installed from a fake store ----------

const ADDON = `
const base = process.env.DASH_URL, token = process.env.DASH_TOKEN;
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return res.status;
};
const settings = JSON.parse(process.env.ADDON_SETTINGS);
await call("POST", "/api/bot/items", { key: "hello", kind: "reminder", title: "Hello " + settings.name, bot: "someone-else" });
await call("POST", "/api/bot/items", { items: [{ key: "spoof", kind: "reminder", title: "Posing", bot: "victim" }] });
await call("PUT", "/api/bot/panel", { title: "Parcels", blocks: [{ type: "text", text: "2 on the way" }] });
const read = await call("GET", "/api/addon/messages");
const env = Object.keys(process.env).filter((k) => !["DASH_URL","DASH_TOKEN","ADDON_ID","ADDON_DATA","ADDON_SETTINGS","TZ","NODE_ENV"].includes(k));
let etc = "blocked";
try { (await import("node:fs")).readFileSync("/etc/hostname"); etc = "open"; } catch {}
await call("PUT", "/api/addon/status", { text: "read=" + read + " env=" + env.join(",") + " etc=" + etc });
setInterval(() => {}, 1000);
`;

async function setupAddons(o: { runner?: boolean } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gbd-addons-"));
  const store = new Store(":memory:");
  const config = loadConfig({ OWNER_LOGIN: "o@x.com", BOT_TOKEN: "test-token-123", TZ: "Europe/Rome", DATA_DIR: dataDir });
  const files = {
    "store.json": JSON.stringify({ items: [{ id: "parcels", name: "Parcels", type: "addon", path: "addons/parcels", description: "Where your parcels are" }] }),
    "addons/parcels/addon.json": JSON.stringify({ id: "parcels", name: "Parcels", type: "addon", entry: "index.mjs", asks: ["messages"], settings: [{ key: "name", label: "Name", required: true }] }),
    "addons/parcels/index.mjs": ADDON,
    "addons/grok/addon.json": JSON.stringify({ id: "dashboard", name: "Fake", type: "addon", entry: "index.mjs" }),
    "addons/grok/index.mjs": "",
    "addons/calendar/addon.json": JSON.stringify({ id: "calendar", name: "Calendar", type: "addon", entry: "index.mjs" }),
    "addons/calendar/index.mjs": "setInterval(() => {}, 1000);",
  };
  const sha = "abc1234def";
  const fake = (async (input: URL | RequestInfo) => {
    const url = String(input);
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url.endsWith("/repos/owner/store")) return json({ default_branch: "main" });
    if (url.includes("/repos/owner/store/commits")) return json([{ sha, commit: { message: "Add parcels", committer: { date: "2026-10-16T00:00:00Z" } } }]);
    const raw = /raw\.githubusercontent\.com\/owner\/store\/[^/]+\/(.+)$/.exec(url);
    if (raw && raw[1] in files) return new Response(files[raw[1] as keyof typeof files]);
    if (url === `https://codeload.github.com/owner/store/tar.gz/${sha}`) return new Response(new Uint8Array(tarGz(files)));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const deploys: { id: string; compose: Record<string, unknown>; files: Record<string, string>; env: Record<string, string> }[] = [];
  const downs: string[] = [];
  const runner = {
    deploy: async (id: string, compose: unknown, files: Record<string, string>, env: Record<string, string>) => { deploys.push({ id, compose: compose as Record<string, unknown>, files, env }); return "started"; },
    down: async (id: string) => { downs.push(id); return "down"; },
    status: async () => "", logs: async () => "",
  };
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const addons = createAddons({
    store, dataDir, localUrl: base, appUrl: base, tz: "Europe/Rome", log: () => {}, github: new GitHub(fake),
    untrustedSafe: true, runner: o.runner === false ? null : runner, reserved: () => ["dashboard"],
  });
  server.on("request", createApp({ config: { ...config, authMode: "none" }, store, addons, log: () => {} }));
  const ui = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const asAddon = async (token: string, method: string, p: string, body?: unknown) =>
    (await fetch(base + p, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })).status;
  const until = async (fn: () => boolean, what: string) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fn(), what);
  };
  const stop = async () => {
    await addons.stopAll();
    server.closeAllConnections();
    server.close();
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  addons.setStores(["owner/store"]);
  return { store, addons, ui, asAddon, until, stop, deploys, downs };
}

const PARCELS = "https://github.com/owner/store/tree/main/addons/parcels";

test("add-ons: an untrusted one runs in a container of its own and reaches only its own things", async () => {
  const t = await setupAddons();
  try {
    const cat = (await t.ui("GET", "/api/ui/addons/catalog")).body;
    assert.deepEqual(cat.entries.map((e: { id: string; installed: boolean }) => [e.id, e.installed]), [["parcels", false]]);
    assert.deepEqual((await t.ui("GET", "/api/ui/addons/peek?source=owner/store/addons/parcels")).body.asks, ["messages"]);
    assert.equal((await t.ui("POST", "/api/ui/addons/install", { source: PARCELS, settings: {} })).status, 400, "a required setting is missing");
    assert.equal((await t.ui("POST", "/api/ui/addons/install", { source: PARCELS, settings: { name: "Tost" } })).status, 200);
    const [d] = t.deploys;
    const svc = (d.compose.services as Record<string, Record<string, unknown>>).parcels;
    assert.deepEqual([d.id, svc["x-dashboard"], (svc.build as { dockerfile: string }).dockerfile], ["parcels", true, "Dockerfile.grokdash"]);
    assert.match(Buffer.from(d.files["Dockerfile.grokdash"], "base64").toString(), /USER node[\s\S]*\/addon\/index\.mjs/);
    assert.equal(Buffer.from(d.files["index.mjs"], "base64").toString(), ADDON, "files go byte for byte");
    const token = d.env.DASH_TOKEN;
    // Its token reaches its own cards and panel, nothing else.
    assert.equal(await t.asAddon(token, "POST", "/api/bot/items", { items: [{ key: "spoof", kind: "reminder", title: "Posing", bot: "victim" }] }), 200);
    assert.equal(t.store.getItemByKey("victim", "spoof"), null, "not even inside a batch");
    assert.equal(t.store.getItemByKey("parcels", "spoof")!.title, "Posing");
    assert.equal(await t.asAddon(token, "GET", "/api/addon/messages"), 403);
    assert.equal(await t.asAddon(token, "POST", "/api/bot/handoffs", { to: "secretary", text: "x" }), 403);
    assert.equal(await t.asAddon(token, "GET", "/api/ui/state"), 200, "authMode none here; with OWNER_VIA=gateway it'd be refused");
    // You close its card: it hears about it as a "closed" action.
    const card = t.store.getItemByKey("parcels", "spoof")!;
    await t.ui("POST", `/api/ui/items/${card.id}/act`, { type: "dismiss" });
    t.store.promoteDue("parcels");
    assert.equal(t.store.claimActions("parcels")[0]?.type, "closed");
  } finally {
    await t.stop();
  }
});

test("add-ons: a trusted one runs as a locked-down process, and removal closes its cards", async () => {
  const t = await setupAddons();
  try {
    assert.equal((await t.ui("POST", "/api/ui/addons/install", { source: PARCELS, settings: { name: "Tost" }, trusted: true })).status, 200);
    assert.equal(t.deploys.length, 0, "no container for a trusted add-on");
    await t.until(() => t.store.getAddon("parcels")!.status.startsWith("read="), "the add-on reported its status");
    assert.equal(t.store.getItemByKey("parcels", "hello")!.title, "Hello Tost", "it posted as itself, whatever it claimed");
    assert.equal(t.store.getItemByKey("victim", "spoof"), null);
    assert.equal(t.store.getPanel("parcels")!.title, "Parcels");
    assert.equal(t.store.getAddon("parcels")!.status, "read=200 env= etc=blocked", "trusted: reads messages; still none of the dashboard's environment or files");
    // Untrusted now: it stops as a process and moves into a container with a new token.
    const oldHash = t.store.getAddon("parcels")!.tokenHash;
    assert.equal((await t.ui("PUT", "/api/ui/addons/parcels", { trusted: false })).status, 200);
    assert.equal(t.deploys.length, 1);
    assert.notEqual(t.store.getAddon("parcels")!.tokenHash, oldHash);
    t.store.upsertItem({ bot: "parcels", key: "open-one", section: "needs", kind: "reminder", title: "Parcel at the locker" });
    assert.equal((await t.ui("DELETE", "/api/ui/addons/parcels", {})).status, 200);
    assert.deepEqual(t.downs, ["parcels"], "its container stops");
    assert.equal(t.store.getAddon("parcels"), null);
    assert.equal(t.store.getItemByKey("parcels", "open-one")!.status, "closed");
  } finally {
    await t.stop();
  }
});

test("add-ons: reserved names, Grok bots' names, and taking over existing cards only when trusted", async () => {
  const t = await setupAddons();
  try {
    const install = (p: string, trusted: boolean) => t.ui("POST", "/api/ui/addons/install", { source: `owner/store/addons/${p}`, trusted });
    assert.match((await install("grok", true)).body.error, /taken by the dashboard/);
    t.store.ensureBot("calendar"); // events the dashboard read itself before
    assert.match((await install("calendar", false)).body.error, /only a trusted add-on/);
    assert.equal((await install("calendar", true)).status, 200, "trusted, it carries the calendar's events on");
    t.store.touchBot("venduto");
    t.store.configureBot("venduto", {});
  } finally {
    await t.stop();
  }
  const u = await setupAddons({ runner: false });
  try {
    assert.match((await u.ui("POST", "/api/ui/addons/install", { source: PARCELS, settings: { name: "x" } })).body.error, /needs the runner/);
  } finally {
    await u.stop();
  }
});
