// The runner: starts, updates and removes apps for the dashboard. It's the only container with the
// Docker socket. It listens on the dashboard's private network only, answers only the dashboard
// (a token derived from BOT_TOKEN), and starts nothing that fails validate.mjs.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { checkCompose, fillVars, runnerToken } from "./validate.mjs";

const APPS = process.env.APPS_DIR ?? "/apps";
const NETWORK = process.env.APP_NETWORK ?? "grokdash";
const PORT = Number(process.env.PORT ?? 8790);
if (!process.env.BOT_TOKEN) {
  console.error("runner: BOT_TOKEN is missing, so the dashboard couldn't prove who it is. Stopping.");
  process.exit(1);
}
const TOKEN = Buffer.from(`Bearer ${await runnerToken(process.env.BOT_TOKEN)}`);
const ID = /^[a-z][a-z0-9-]{1,30}$/;

function docker(args, cwd, timeoutMs = 15 * 60_000) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      if (err) reject(new Error(out.split("\n").slice(-8).join("\n") || err.message));
      else resolve(out);
    });
  });
}

const compose = (id, ...args) => docker(["compose", "-p", `gd-${id}`, "-f", "compose.json", ...args], path.join(APPS, id));

async function deploy(id, body) {
  const env = body.env ?? {};
  // Placeholders are filled first; the injected values get their "$" escaped so Compose leaves them alone.
  const escaped = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v).replaceAll("$", "$$$$")]));
  const checked = checkCompose(fillVars(body.compose, env), { id, network: NETWORK, env: escaped });
  const dir = path.join(APPS, id);
  fs.mkdirSync(dir, { recursive: true });
  // The app's own folder, for builds from ".". Nothing may land outside it.
  for (const [rel, content] of Object.entries(body.files ?? {})) {
    const file = path.resolve(dir, "src", rel);
    if (!file.startsWith(path.join(dir, "src") + path.sep)) throw new Error(`Refused a file outside the app folder: ${rel}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(content));
  }
  for (const svc of Object.values(checked.services)) {
    if (!svc.build) continue;
    const b = typeof svc.build === "string" ? { context: svc.build } : svc.build;
    if (!b.context.startsWith("https://")) b.context = path.join("src", b.context);
    svc.build = b;
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
      const out = await compose(id, "down", ...(u.searchParams.get("purge") === "1" ? ["-v"] : []));
      fs.rmSync(path.join(APPS, id), { recursive: true, force: true });
      return send(res, 200, { output: out });
    }
    if (req.method === "GET" && m[2]) return send(res, 200, { output: await compose(id, "logs", "--tail", "100", "--no-color") });
    if (req.method === "GET") return send(res, 200, { output: await compose(id, "ps", "--format", "json") });
    send(res, 405, { error: "Method not allowed." });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
}).listen(PORT, "0.0.0.0", () => console.log(`runner on :${PORT}, apps in ${APPS}, network ${NETWORK}`));
