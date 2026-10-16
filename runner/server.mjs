// The runner: starts, updates and removes apps for the dashboard. It's the only container with the
// Docker socket. It sits on a network only the dashboard shares, answers only the key it made at its
// first start (in a volume only the dashboard also mounts), and starts nothing that fails validate.mjs.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { checkCompose, fillVars } from "./validate.mjs";

const APPS = process.env.APPS_DIR ?? "/apps";
const NETWORK = process.env.APP_NETWORK ?? "grokdash";
const PORT = Number(process.env.PORT ?? 8790);
const KEY_FILE = process.env.KEY_FILE ?? "/keys/runner.key";
if (!fs.existsSync(KEY_FILE)) {
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, randomBytes(32).toString("hex"), { mode: 0o644 });
}
const TOKEN = Buffer.from(`Bearer ${fs.readFileSync(KEY_FILE, "utf8").trim()}`);
// Docker and Compose get only what they need, so nothing can be filled in from here.
const DOCKER_ENV = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/root" };
const ID = /^[a-z][a-z0-9-]{1,30}$/;

function docker(args, cwd, timeoutMs = 15 * 60_000) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { cwd, env: DOCKER_ENV, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      if (err) reject(new Error(out.split("\n").slice(-8).join("\n") || err.message));
      else resolve(out);
    });
  });
}

/** Every other deployed app's service names, so no two apps answer to the same name. */
function deployed() {
  const out = {};
  for (const other of fs.existsSync(APPS) ? fs.readdirSync(APPS) : []) {
    try {
      out[other] = Object.keys(JSON.parse(fs.readFileSync(path.join(APPS, other, "compose.json"), "utf8")).services ?? {});
    } catch {
      out[other] = [];
    }
  }
  return out;
}

const compose = (id, ...args) => docker(["compose", "-p", `gd-${id}`, "-f", "compose.json", ...args], path.join(APPS, id));

async function deploy(id, body) {
  const env = body.env ?? {};
  // Placeholders are filled first; the injected values get their "$" escaped so Compose leaves them alone.
  const escaped = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v).replaceAll("$", "$$$$")]));
  const checked = checkCompose(fillVars(body.compose, env), { id, network: NETWORK, env: escaped, others: deployed() });
  const dir = path.join(APPS, id);
  const src = path.join(dir, "src");
  // A fresh copy of the app's folder each time, so files removed from the repo are gone here too.
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  for (const [rel, content] of Object.entries(body.files ?? {})) {
    const file = path.resolve(src, rel);
    if (!file.startsWith(src + path.sep)) throw new Error(`Refused a file outside the app folder: ${rel}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(String(content), "base64"));
  }
  for (const svc of Object.values(checked.services)) {
    if (svc.build && !svc.build.context.startsWith("https://")) svc.build.context = path.join("src", svc.build.context);
  }
  fs.writeFileSync(path.join(dir, "compose.json"), JSON.stringify(checked, null, 2));
  return compose(id, "up", "-d", "--build", "--remove-orphans");
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  try {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    if (got.length !== TOKEN.length || !timingSafeEqual(got, TOKEN)) return send(res, 401, { error: "Wrong runner token." });
    const u = new URL(req.url, "http://runner");
    const m = /^\/apps\/([^/]+)(\/logs)?$/.exec(u.pathname);
    if (!m || !ID.test(m[1])) return send(res, 404, { error: "No such route." });
    const id = m[1];
    if (req.method === "PUT" && !m[2]) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      return send(res, 200, { output: await deploy(id, body) });
    }
    if (!fs.existsSync(path.join(APPS, id, "compose.json"))) return send(res, 404, { error: `App ${id} isn't deployed.` });
    if (req.method === "DELETE") {
      const purge = u.searchParams.get("purge") === "1";
      const out = await compose(id, "down", ...(purge ? ["-v"] : []));
      // Kept after a plain stop, so the volumes can still be found and removed later.
      if (purge) fs.rmSync(path.join(APPS, id), { recursive: true, force: true });
      return send(res, 200, { output: out });
    }
    if (req.method === "GET" && m[2]) return send(res, 200, { output: await compose(id, "logs", "--tail", "100", "--no-color") });
    if (req.method === "GET") return send(res, 200, { output: await compose(id, "ps", "--format", "json") });
    send(res, 405, { error: "Method not allowed." });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
}).listen(PORT, "0.0.0.0", () => console.log(`runner on :${PORT}, apps in ${APPS}, network ${NETWORK}`));
