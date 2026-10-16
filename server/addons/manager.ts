// Installs, updates and runs add-ons and apps from stores (GitHub repos with a store.json).
//
// An add-on is a script the dashboard runs in its own Node process, under Node's permission model:
// it reads only its own folder, writes only its data folder, and can't start other programs.
// It gets the dashboard's address, a token and its settings, and nothing else from the environment.
// An app is a set of containers the runner starts (see runner/). Both talk to the dashboard over
// the bot API with their token, and untrusted ones can only reach their own cards, panel and status.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Store, AddonRow } from "../store.ts";
import { GitHub, parseRepoRef, type RepoRef } from "./github.ts";
import { filesUnder } from "./tar.ts";
import { checkSettings, parseManifest, type Manifest } from "./manifest.ts";

export const DEFAULT_STORE = "SuperTost100/grokdash-store";
const CATALOG_TTL_MS = 10 * 60_000;
const UPDATE_EVERY_MS = 12 * 3_600_000;
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];
const LOG_LINES = 200;

export interface CatalogEntry {
  store: string;
  path: string;
  id: string;
  name: string;
  type: "addon" | "app";
  description: string;
  memory: string;
}

export interface Runner {
  deploy(id: string, compose: unknown, files: Record<string, string>, env: Record<string, string>): Promise<string>;
  down(id: string, purge: boolean): Promise<string>;
  status(id: string): Promise<string>;
  logs(id: string): Promise<string>;
}

export const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

interface Proc {
  child: ChildProcess | null;
  crashes: number;
  startedAt: number;
  timer: NodeJS.Timeout | null;
  stopping: boolean;
}

export function createAddons(o: {
  store: Store;
  dataDir: string;
  /** How add-ons reach the dashboard: from the dashboard's own process, and from an app's containers. */
  localUrl: string;
  appUrl: string;
  tz: string;
  log: (msg: string) => void;
  github?: GitHub;
  runner?: Runner | null;
}) {
  const { store, log } = o;
  const github = o.github ?? new GitHub();
  const root = path.join(o.dataDir, "addons");
  const procs = new Map<string, Proc>();
  const logs = new Map<string, string[]>();
  let catalogCache: { at: number; entries: CatalogEntry[]; errors: { store: string; error: string }[] } | null = null;

  const dirs = (id: string) => ({ code: path.join(root, id, "code"), data: path.join(root, id, "data") });
  const manifestOf = (a: AddonRow) => a.manifest as Manifest;

  function note(id: string, line: string) {
    const list = logs.get(id) ?? [];
    list.push(`${new Date(store.now()).toISOString().slice(11, 19)} ${line}`.slice(0, 500));
    if (list.length > LOG_LINES) list.splice(0, list.length - LOG_LINES);
    logs.set(id, list);
  }

  function stores(): string[] {
    const raw = store.getState("addons:stores");
    return raw ? JSON.parse(raw) : [DEFAULT_STORE];
  }

  function setStores(list: string[]) {
    store.setState("addons:stores", JSON.stringify([...new Set(list)]));
    catalogCache = null;
  }

  async function catalog(force = false) {
    if (!force && catalogCache && store.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache;
    const entries: CatalogEntry[] = [];
    const errors: { store: string; error: string }[] = [];
    for (const repo of stores()) {
      try {
        const branch = await github.defaultBranch(repo);
        const head = await github.latest(repo, branch);
        const index = JSON.parse(await github.file(repo, head.sha, "store.json")) as { items?: unknown[] };
        for (const raw of index.items ?? []) {
          const e = raw as Record<string, unknown>;
          if (typeof e.path !== "string" || typeof e.id !== "string" || typeof e.name !== "string") continue;
          entries.push({
            store: repo, path: e.path, id: e.id, name: e.name, type: e.type === "app" ? "app" : "addon",
            description: typeof e.description === "string" ? e.description : "", memory: typeof e.memory === "string" ? e.memory : "",
          });
        }
      } catch (err) {
        errors.push({ store: repo, error: (err as Error).message });
      }
    }
    catalogCache = { at: store.now(), entries, errors };
    return catalogCache;
  }

  /** Fetch a folder at the newest commit and check its addon.json. */
  async function fetchFolder(ref: RepoRef) {
    const branch = ref.branch || (await github.defaultBranch(ref.repo));
    const head = await github.latest(ref.repo, branch);
    const folderHead = ref.path ? await github.latest(ref.repo, branch, ref.path) : head;
    const files = filesUnder(await github.tarball(ref.repo, head.sha), ref.path);
    const raw = files.get("addon.json");
    if (!raw) throw new Error(`No addon.json in ${ref.repo}/${ref.path || ""}`);
    const manifest = parseManifest(JSON.parse(raw.toString("utf8")));
    if (manifest.type === "addon" && !files.has(manifest.entry)) throw new Error(`${manifest.name}: its entry file ${manifest.entry} is missing`);
    if (manifest.type === "app" && !files.has(manifest.compose)) throw new Error(`${manifest.name}: its compose file ${manifest.compose} is missing`);
    return { branch, sha: head.sha, pathSha: folderHead.sha, files, manifest };
  }

  /** What an add-on asks for and which settings it needs, before installing it. */
  async function peek(source: string): Promise<Manifest> {
    const ref = parseRepoRef(source);
    const branch = ref.branch || (await github.defaultBranch(ref.repo));
    const head = await github.latest(ref.repo, branch);
    return parseManifest(JSON.parse(await github.file(ref.repo, head.sha, `${ref.path ? `${ref.path}/` : ""}addon.json`)));
  }

  function writeFiles(id: string, files: Map<string, Buffer>) {
    const { code, data } = dirs(id);
    fs.rmSync(code, { recursive: true, force: true });
    for (const [rel, buf] of files) {
      const file = path.join(code, rel);
      if (!file.startsWith(code + path.sep)) throw new Error(`Refused a file outside the add-on folder: ${rel}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
    }
    fs.mkdirSync(data, { recursive: true });
  }

  function registerOwner(m: Manifest) {
    // Its cards, panel and to-dos hang off a bot row of its own, which never shows on the Bots page.
    store.ensureBot(m.id);
    store.configureBot(m.id, { kind: m.type, name: m.name, color: m.color || undefined, role: m.description.slice(0, 120) });
  }

  async function install(source: string, opts: { trusted: boolean; settings: Record<string, unknown> }) {
    const ref = parseRepoRef(source);
    const got = await fetchFolder(ref);
    const m = got.manifest;
    const existing = store.getAddon(m.id);
    if (existing) throw new Error(`${m.name} is already installed. Update it instead.`);
    const bot = store.getBot(m.id);
    if (bot && bot.kind === "bot") throw new Error(`A bot is already called "${m.id}".`);
    if (m.type === "app" && !o.runner) throw new Error(`${m.name} runs its own containers, and the runner isn't set up.`);
    const settings = checkSettings(m.settings, opts.settings);
    writeFiles(m.id, got.files);
    registerOwner(m);
    const now = store.now();
    store.saveAddon({
      id: m.id, type: m.type, manifest: m, repo: ref.repo, branch: got.branch, path: ref.path, sha: got.sha, pathSha: got.pathSha,
      trusted: opts.trusted, enabled: true, settings, tokenHash: "", status: "Starting…", statusOk: true,
      updateSha: "", updateNotes: [], checkedAt: now, installedAt: now, updatedAt: now,
    });
    log(`add-on ${m.id} installed from ${ref.repo}/${ref.path} at ${got.sha.slice(0, 7)}${opts.trusted ? ", trusted" : ""}`);
    await start(m.id);
    return store.getAddon(m.id)!;
  }

  async function update(id: string) {
    const a = mustGet(id);
    const got = await fetchFolder({ repo: a.repo, branch: a.branch, path: a.path });
    if (got.manifest.id !== id) throw new Error(`The folder now holds "${got.manifest.id}", not "${id}". Remove and install it instead.`);
    // New required settings with no value yet stop the update here, before anything changes.
    const settings = checkSettings(got.manifest.settings, a.settings, a.settings);
    await stop(id);
    writeFiles(id, got.files);
    registerOwner(got.manifest);
    store.saveAddon({ ...a, manifest: got.manifest, type: got.manifest.type, sha: got.sha, pathSha: got.pathSha, settings, updateSha: "", updateNotes: [], checkedAt: store.now(), updatedAt: store.now() });
    log(`add-on ${id} updated to ${got.sha.slice(0, 7)}`);
    await start(id);
    return store.getAddon(id)!;
  }

  async function remove(id: string, purge = false) {
    const a = mustGet(id);
    await stop(id);
    if (a.type === "app" && o.runner) note(id, await o.runner.down(id, purge).catch((e: Error) => `runner: ${e.message}`));
    fs.rmSync(path.join(root, id, "code"), { recursive: true, force: true });
    if (purge) fs.rmSync(path.join(root, id), { recursive: true, force: true });
    store.deletePanel(id);
    for (const item of store.liveItemsOf(id)) store.closeItem(item.id, "bot", `${manifestOf(a).name} was removed`);
    store.deleteAddon(id);
    log(`add-on ${id} removed${purge ? " with its data" : ""}`);
  }

  async function configure(id: string, patch: { trusted?: boolean; enabled?: boolean; settings?: Record<string, unknown> }) {
    const a = mustGet(id);
    const settings = patch.settings ? checkSettings(manifestOf(a).settings, patch.settings, a.settings) : a.settings;
    store.saveAddon({ ...a, trusted: patch.trusted ?? a.trusted, enabled: patch.enabled ?? a.enabled, settings, updatedAt: store.now() });
    await stop(id);
    if (patch.enabled ?? a.enabled) await start(id);
    else store.setAddonStatus(id, "Turned off", true);
    return store.getAddon(id)!;
  }

  function mustGet(id: string) {
    const a = store.getAddon(id);
    if (!a) throw new Error(`No add-on called "${id}".`);
    return a;
  }

  /** A fresh token for every start: the old one stops working the moment the add-on restarts. */
  function newToken(a: AddonRow) {
    const token = crypto.randomBytes(32).toString("base64url");
    store.saveAddon({ ...store.getAddon(a.id)!, tokenHash: hashToken(token) });
    return token;
  }

  async function start(id: string) {
    const a = mustGet(id);
    if (!a.enabled) return;
    const m = manifestOf(a);
    const { code, data } = dirs(id);
    if (a.type === "app") {
      if (!o.runner) return store.setAddonStatus(id, "The runner isn't set up, so this app can't start.", false);
      const token = newToken(a);
      const files: Record<string, string> = {};
      for (const f of walk(code)) files[f] = fs.readFileSync(path.join(code, f), "utf8");
      try {
        const out = await o.runner.deploy(id, JSON.parse(files[m.compose]), files, {
          DASH_URL: o.appUrl, DASH_TOKEN: token, ADDON_ID: id, TZ: o.tz, ADDON_SETTINGS: JSON.stringify(a.settings),
          ...Object.fromEntries(Object.entries(a.settings).map(([k, v]) => [`SETTING_${k.toUpperCase()}`, String(v)])),
        });
        note(id, out.trim().split("\n").slice(-5).join(" / "));
        store.setAddonStatus(id, "Running", true);
      } catch (err) {
        note(id, `deploy failed: ${(err as Error).message}`);
        store.setAddonStatus(id, `Couldn't start: ${(err as Error).message}`, false);
      }
      return;
    }
    const p = procs.get(id) ?? { child: null, crashes: 0, startedAt: 0, timer: null, stopping: false };
    procs.set(id, p);
    if (p.child) return;
    p.stopping = false;
    const token = newToken(a);
    const child = spawn(
      process.execPath,
      ["--permission", `--allow-fs-read=${code}`, `--allow-fs-read=${data}`, `--allow-fs-write=${data}`, path.join(code, m.entry)],
      {
        cwd: data,
        // Only these: no secrets of the dashboard's own environment reach an add-on.
        env: { DASH_URL: o.localUrl, DASH_TOKEN: token, ADDON_ID: id, ADDON_DATA: data, ADDON_SETTINGS: JSON.stringify(a.settings), TZ: o.tz, NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    p.child = child;
    p.startedAt = store.now();
    const lines = (chunk: Buffer) => chunk.toString("utf8").split("\n").filter(Boolean).forEach((l) => note(id, l));
    child.stdout!.on("data", lines);
    child.stderr!.on("data", lines);
    child.on("exit", (codeNum, signal) => {
      p.child = null;
      if (p.stopping) return;
      // It ran for a while: earlier crashes are forgiven.
      if (store.now() - p.startedAt > 10 * 60_000) p.crashes = 0;
      const wait = BACKOFF_MS[Math.min(p.crashes, BACKOFF_MS.length - 1)];
      p.crashes++;
      const last = (logs.get(id) ?? []).at(-1) ?? "";
      note(id, `stopped (${signal ?? `exit ${codeNum}`}), restarting in ${Math.round(wait / 1000)} s`);
      store.setAddonStatus(id, `Stopped${last ? `: ${last.slice(9, 200)}` : ""}. Restarting in ${Math.round(wait / 1000)} s.`, false);
      p.timer = setTimeout(() => { p.timer = null; void start(id); }, wait);
    });
    note(id, `started ${m.entry}`);
  }

  async function stop(id: string) {
    const p = procs.get(id);
    if (p) {
      p.stopping = true;
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
      const child = p.child;
      if (child) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
          setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000).unref();
        });
      }
      procs.delete(id);
    }
    const a = store.getAddon(id);
    // The old token stops working at once.
    if (a) store.saveAddon({ ...a, tokenHash: "" });
  }

  async function checkUpdates(force = false) {
    for (const a of store.listAddons()) {
      if (!force && a.checkedAt && store.now() - a.checkedAt < UPDATE_EVERY_MS) continue;
      try {
        const commits = await github.commits(a.repo, a.branch, a.path, 20);
        const idx = commits.findIndex((c) => c.sha === a.pathSha);
        const newer = idx === -1 ? commits : commits.slice(0, idx);
        const fresh = store.getAddon(a.id)!;
        store.saveAddon({ ...fresh, updateSha: newer[0]?.sha ?? "", updateNotes: newer.map((c) => c.message), checkedAt: store.now() });
      } catch (err) {
        log(`add-on ${a.id}: update check failed: ${(err as Error).message}`);
      }
    }
  }

  async function startAll() {
    for (const a of store.listAddons()) if (a.enabled && a.type === "addon") await start(a.id);
  }

  async function stopAll() {
    await Promise.all([...procs.keys()].map(stop));
  }

  function view() {
    return store.listAddons().map((a) => {
      const m = manifestOf(a);
      return {
        id: a.id, type: a.type, name: m.name, description: m.description, color: m.color, memory: m.memory, asks: m.asks,
        source: `${a.repo}${a.path ? `/${a.path}` : ""}`, sha: a.sha.slice(0, 7), trusted: a.trusted, enabled: a.enabled,
        running: a.type === "app" ? a.statusOk : Boolean(procs.get(a.id)?.child),
        status: a.status, statusOk: a.statusOk,
        update: a.updateSha ? { sha: a.updateSha.slice(0, 7), notes: a.updateNotes } : null,
        // Secrets never go back to the page: it only learns whether one is saved.
        settings: m.settings.map((d) => ({ ...d, value: d.type === "secret" ? (a.settings[d.key] !== undefined ? "set" : "") : a.settings[d.key] ?? "" })),
      };
    });
  }

  return {
    stores, setStores, catalog, peek, install, update, remove, configure, start, stop, startAll, stopAll, checkUpdates, view,
    logs: (id: string) => logs.get(id) ?? [],
    runnerOn: () => Boolean(o.runner),
  };
}

export type Addons = ReturnType<typeof createAddons>;

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}
