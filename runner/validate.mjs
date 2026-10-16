// The rules an app's compose file must follow before the runner starts it. The runner holds the
// Docker socket, which is as good as root on the machine, so this is the line that matters:
// nothing privileged, no host network or devices, no folders from the host, no published ports.
// Every service joins the dashboard's network and gets a memory limit.

const SERVICE_KEYS = new Set([
  "image", "build", "command", "entrypoint", "environment", "volumes", "restart", "healthcheck", "depends_on",
  "working_dir", "user", "expose", "init", "stop_grace_period", "mem_limit", "cpus", "labels", "x-dashboard", "tmpfs", "shm_size",
]);
const NAME = /^[a-z][a-z0-9_-]{0,40}$/;
const MAX_MEM = 2 * 1024 ** 3;

function bytes(v) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(String(v));
  if (!m) return NaN;
  return Number(m[1]) * { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
}

/**
 * Check an app's compose (as JSON) and return the version the runner starts.
 * `network` is the dashboard's network; `id` names the app; `env` goes to services marked "x-dashboard".
 */
export function checkCompose(compose, { id, network, env }) {
  if (!compose || typeof compose !== "object" || Array.isArray(compose)) throw new Error("The compose file must be a JSON object.");
  for (const k of Object.keys(compose)) {
    if (!["services", "volumes", "name"].includes(k) && !k.startsWith("x-")) throw new Error(`Apps can't set "${k}" in their compose file.`);
  }
  const volumes = compose.volumes ?? {};
  if (typeof volumes !== "object" || Array.isArray(volumes)) throw new Error(`"volumes" must be an object of named volumes.`);
  for (const [name, def] of Object.entries(volumes)) {
    if (!NAME.test(name)) throw new Error(`Volume name "${name}" isn't allowed.`);
    if (def && (typeof def !== "object" || Object.keys(def).length)) throw new Error(`Volume "${name}" can't set a driver or options: only plain named volumes.`);
  }
  const services = compose.services;
  if (!services || typeof services !== "object" || !Object.keys(services).length) throw new Error("The compose file needs at least one service.");
  const out = { name: `gd-${id}`, services: {}, volumes: {}, networks: { dashboard: { name: network, external: true } } };
  for (const name of Object.keys(volumes)) out.volumes[name] = {};
  for (const [name, svc] of Object.entries(services)) {
    if (!NAME.test(name)) throw new Error(`Service name "${name}" isn't allowed.`);
    if (!svc || typeof svc !== "object") throw new Error(`Service "${name}" must be an object.`);
    for (const k of Object.keys(svc)) if (!SERVICE_KEYS.has(k)) throw new Error(`Service "${name}" can't set "${k}".`);
    if (!svc.image && !svc.build) throw new Error(`Service "${name}" needs an image or a build.`);
    if (svc.image && (typeof svc.image !== "string" || !/^[\w./:@-]+$/.test(svc.image))) throw new Error(`Service "${name}" has a strange image name.`);
    if (svc.build !== undefined) {
      const ctx = typeof svc.build === "string" ? svc.build : svc.build?.context;
      // Its own folder, or a public GitHub repo. Never a path elsewhere on this machine.
      if (typeof ctx !== "string" || !(ctx === "." || /^\.\/[\w.-]+$/.test(ctx) || /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git(#[\w./-]+)?$/.test(ctx))) {
        throw new Error(`Service "${name}" may only build from its own folder or a github.com repo.`);
      }
      if (typeof svc.build === "object") {
        for (const k of Object.keys(svc.build)) if (!["context", "dockerfile", "args"].includes(k)) throw new Error(`Service "${name}" can't set build.${k}.`);
      }
    }
    // Written out in Compose's long form, so nothing is left to interpretation.
    const mounts = (svc.volumes ?? []).map((v) => {
      if (typeof v !== "string") throw new Error(`Service "${name}": write volumes as "name:/path".`);
      const [src, dst, mode, ...rest] = v.split(":");
      if (rest.length || !dst || !dst.startsWith("/") || (mode && mode !== "ro" && mode !== "rw")) throw new Error(`Service "${name}": volume "${v}" must look like "name:/path".`);
      if (!(src in volumes)) throw new Error(`Service "${name}": only named volumes from this file, not "${src}" (no folders from the host).`);
      return { type: "volume", source: src, target: dst, read_only: mode === "ro" };
    });
    const mem = svc.mem_limit === undefined ? 512 * 1024 ** 2 : bytes(svc.mem_limit);
    if (!(mem > 0 && mem <= MAX_MEM)) throw new Error(`Service "${name}": mem_limit must be at most 2g.`);
    if (svc.cpus !== undefined && !(Number(svc.cpus) > 0 && Number(svc.cpus) <= 2)) throw new Error(`Service "${name}": cpus must be at most 2.`);
    if (svc.user !== undefined && /^(0|root)(:|$)/.test(String(svc.user))) throw new Error(`Service "${name}" can't run as root by choice.`);
    const { "x-dashboard": wantsDash, ...rest } = svc;
    const environment = Array.isArray(rest.environment)
      ? Object.fromEntries(rest.environment.map((e) => { const i = String(e).indexOf("="); return i === -1 ? [e, ""] : [e.slice(0, i), e.slice(i + 1)]; }))
      : { ...(rest.environment ?? {}) };
    // The dashboard's address and the app's token only go where the app asks for them.
    if (wantsDash === true) Object.assign(environment, env);
    out.services[name] = {
      ...rest,
      volumes: mounts,
      environment,
      mem_limit: mem,
      restart: rest.restart ?? "unless-stopped",
      networks: ["dashboard"],
      security_opt: ["no-new-privileges:true"],
      cap_drop: rest.user === undefined ? undefined : ["ALL"],
      labels: { ...(rest.labels ?? {}), "grokdash.app": id },
    };
    if (out.services[name].cap_drop === undefined) delete out.services[name].cap_drop;
  }
  return out;
}

/**
 * Fill ${NAME} placeholders from the app's settings and the dashboard's values, and escape every
 * other "$" so Compose doesn't fill anything in from the runner's own environment.
 */
export function fillVars(value, env) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}|\$/g, (m, name) => (name ? (env[name] ?? "").replaceAll("$", "$$$$") : "$$"));
  }
  if (Array.isArray(value)) return value.map((v) => fillVars(v, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillVars(v, env)]));
  return value;
}

/** The token the dashboard and the runner share, derived from the bot token both already have. */
export async function runnerToken(botToken) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(`grokdash-runner:${botToken}`).digest("hex");
}
