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

/**
 * Environment and build arguments with a value for every name. A name without one would make Compose
 * take it from the runner's own environment.
 */
function values(v, what) {
  const list = Array.isArray(v)
    ? v.map((e) => {
        const i = typeof e === "string" ? e.indexOf("=") : -1;
        if (i < 1) throw new Error(`${what}: write "NAME=value", got ${JSON.stringify(e)}.`);
        return [e.slice(0, i), e.slice(i + 1)];
      })
    : v && typeof v === "object" ? Object.entries(v) : null;
  if (!list) throw new Error(`${what} must be an object or a list.`);
  const out = {};
  for (const [k, val] of list) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`${what}: "${k}" isn't a valid name.`);
    if (!["string", "number", "boolean"].includes(typeof val)) throw new Error(`${what}: "${k}" needs a value.`);
    out[k] = String(val);
  }
  return out;
}

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
    // Service names are addresses on the shared network: an app may only use names it owns,
    // so it can't answer for "dashboard", "runner" or another app's services.
    if (name !== id && !name.startsWith(`${id}-`)) throw new Error(`Service "${name}" must be named "${id}" or start with "${id}-".`);
    if (!svc || typeof svc !== "object") throw new Error(`Service "${name}" must be an object.`);
    for (const k of Object.keys(svc)) if (!SERVICE_KEYS.has(k)) throw new Error(`Service "${name}" can't set "${k}".`);
    if (!svc.image && !svc.build) throw new Error(`Service "${name}" needs an image or a build.`);
    if (svc.image && (typeof svc.image !== "string" || !/^[\w./:@-]+$/.test(svc.image))) throw new Error(`Service "${name}" has a strange image name.`);
    let build;
    if (svc.build !== undefined) {
      const b = typeof svc.build === "string" ? { context: svc.build } : svc.build;
      if (!b || typeof b !== "object") throw new Error(`Service "${name}": "build" must be a folder or an object.`);
      for (const k of Object.keys(b)) if (!["context", "dockerfile", "args"].includes(k)) throw new Error(`Service "${name}" can't set build.${k}.`);
      // Its own folder (or a folder in it), or a public GitHub repo. Never a path elsewhere on this machine.
      const ctx = b.context;
      const local = typeof ctx === "string" && /^\.(\/[\w-][\w.-]*)*$/.test(ctx) && !ctx.split("/").includes("..");
      const git = typeof ctx === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git(#[\w./-]+)?$/.test(ctx) && !ctx.includes("..");
      if (!local && !git) throw new Error(`Service "${name}" may only build from its own folder or a github.com repo.`);
      if (b.dockerfile !== undefined && (typeof b.dockerfile !== "string" || !/^[\w-][\w.-]*$/.test(b.dockerfile))) {
        throw new Error(`Service "${name}": build.dockerfile must be a file name inside the build folder.`);
      }
      build = { context: ctx, ...(b.dockerfile ? { dockerfile: b.dockerfile } : {}), ...(b.args !== undefined ? { args: values(b.args, `Service "${name}" build.args`) } : {}) };
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
    const environment = rest.environment === undefined ? {} : values(rest.environment, `Service "${name}" environment`);
    // The dashboard's address and the app's token only go where the app asks for them.
    if (wantsDash === true) Object.assign(environment, env);
    out.services[name] = {
      ...rest,
      // A build gets a tag the runner picks, so an app can't overwrite another image on this machine.
      ...(build ? { build, image: `gd-${id}-${name}:latest` } : {}),
      volumes: mounts,
      environment,
      mem_limit: mem,
      restart: rest.restart ?? "unless-stopped",
      networks: ["dashboard"],
      security_opt: ["no-new-privileges:true"],
      // Raw sockets would let a container forge packets on the dashboard's network.
      cap_drop: rest.user === undefined ? ["NET_RAW"] : ["ALL"],
      labels: { ...(rest.labels ?? {}), "grokdash.app": id },
    };
  }
  return out;
}

/**
 * Fill ${SETTING_X} placeholders with the app's own settings, and escape every other "$" so Compose
 * fills nothing in from the runner's environment. "$$" (Compose's own escape) stays as it is.
 * The dashboard's address and token are never placeholders: they only reach "x-dashboard" services.
 */
export function fillVars(value, env) {
  if (typeof value === "string") {
    return value.replace(/\$\$|\$\{(SETTING_[A-Z0-9_]+)\}|\$/g, (m, name) => (m === "$$" ? "$$" : name ? (env[name] ?? "").replaceAll("$", "$$$$") : "$$"));
  }
  if (Array.isArray(value)) return value.map((v) => fillVars(v, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillVars(v, env)]));
  return value;
}
