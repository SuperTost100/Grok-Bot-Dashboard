// addon.json: what an add-on or app is, what it asks for and which settings it needs.

export const ASKS = {
  messages: "Read your mail and chats as the dashboard received them",
  agenda: "Read your agenda",
  todos: "Read your to-dos",
  cards: "Read every card",
  handoffs: "Hand work to your bots, which spends Grok runs",
  triage: "Send messages to triage, which decides what needs you",
  decide: "Ask Jev questions, a fraction of a cent each",
} as const;
export type Ask = keyof typeof ASKS;

export interface SettingDef {
  key: string;
  label: string;
  help: string;
  type: "text" | "secret" | "number" | "bool" | "url" | "select";
  options?: string[];
  default?: string | number | boolean;
  required?: boolean;
}

export interface Manifest {
  id: string;
  name: string;
  /** addon: runs inside the dashboard. app: runs its own containers. */
  type: "addon" | "app";
  description: string;
  color: string;
  /** addon: the script to run, inside the folder. */
  entry: string;
  /** app: the compose file (JSON), inside the folder. */
  compose: string;
  /** app: about how much memory it uses, for the store page. */
  memory: string;
  settings: SettingDef[];
  asks: Ask[];
}

const ID = /^[a-z][a-z0-9-]{1,30}$/;
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
const FILE = /^[\w.-][\w./-]{0,120}$/;

function str(v: unknown, field: string, max: number, required = false): string {
  if (v == null || v === "") {
    if (required) throw new Error(`addon.json needs "${field}"`);
    return "";
  }
  if (typeof v !== "string" || v.length > max) throw new Error(`addon.json "${field}" must be text up to ${max} characters`);
  return v;
}

export function parseManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("addon.json must be a JSON object");
  const m = raw as Record<string, unknown>;
  const id = str(m.id, "id", 31, true);
  if (!ID.test(id)) throw new Error(`addon.json "id" must be lowercase letters, digits and dashes, like "shipments"`);
  const type = m.type === "app" ? "app" : m.type === "addon" ? "addon" : null;
  if (!type) throw new Error(`addon.json "type" must be "addon" or "app"`);
  const entry = str(m.entry, "entry", 120, type === "addon");
  const compose = str(m.compose, "compose", 120, type === "app");
  for (const f of [entry, compose]) if (f && (!FILE.test(f) || f.includes(".."))) throw new Error(`addon.json file names must stay inside the folder: ${f}`);
  const color = str(m.color, "color", 9);
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`addon.json "color" must look like #3b6fb6`);
  if (m.asks != null && !Array.isArray(m.asks)) throw new Error(`addon.json "asks" must be a list`);
  const asks = ((m.asks as unknown[]) ?? []).map((a) => {
    if (typeof a !== "string" || !(a in ASKS)) throw new Error(`addon.json asks for "${a}", which isn't one of: ${Object.keys(ASKS).join(", ")}`);
    return a as Ask;
  });
  if (m.settings != null && (!Array.isArray(m.settings) || m.settings.length > 40)) throw new Error(`addon.json "settings" must be a list of up to 40`);
  const settings = ((m.settings as unknown[]) ?? []).map((s, i): SettingDef => {
    if (!s || typeof s !== "object") throw new Error(`addon.json settings[${i}] must be an object`);
    const d = s as Record<string, unknown>;
    const key = str(d.key, `settings[${i}].key`, 41, true);
    if (!KEY.test(key)) throw new Error(`addon.json settings[${i}].key must be letters, digits and _`);
    const t = d.type ?? "text";
    if (!["text", "secret", "number", "bool", "url", "select"].includes(t as string)) throw new Error(`addon.json settings[${i}].type isn't known: ${t}`);
    const options = d.options == null ? undefined : Array.isArray(d.options) && d.options.every((o) => typeof o === "string") ? (d.options as string[]) : null;
    if (options === null) throw new Error(`addon.json settings[${i}].options must be a list of text`);
    if (t === "select" && !options?.length) throw new Error(`addon.json settings[${i}] is a select without options`);
    const def = d.default;
    if (def != null && !["string", "number", "boolean"].includes(typeof def)) throw new Error(`addon.json settings[${i}].default must be text, a number or true/false`);
    return {
      key,
      label: str(d.label, `settings[${i}].label`, 60, true),
      help: str(d.help, `settings[${i}].help`, 400),
      type: t as SettingDef["type"],
      options,
      default: def as SettingDef["default"],
      required: d.required === true,
    };
  });
  return {
    id, type, entry, compose, color, settings, asks,
    name: str(m.name, "name", 40, true),
    description: str(m.description, "description", 400),
    memory: str(m.memory, "memory", 20),
  };
}

/** Settings as the add-on gets them: checked against the manifest, defaults filled in. */
export function checkSettings(defs: SettingDef[], values: Record<string, unknown>, keepSecrets: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const d of defs) {
    let v = values[d.key];
    // Secrets are write-only on the page: an empty field keeps the saved one.
    if (d.type === "secret" && (v === undefined || v === "")) v = keepSecrets[d.key];
    if (v === undefined || v === "" || v === null) v = d.default;
    if (v === undefined || v === "") {
      if (d.required) throw new Error(`${d.label} is needed.`);
      continue;
    }
    if (d.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${d.label} must be a number.`);
      out[d.key] = n;
    } else if (d.type === "bool") {
      out[d.key] = v === true || v === "true";
    } else {
      const s = String(v);
      if (s.length > 4000) throw new Error(`${d.label} is too long.`);
      if (d.type === "url" && !/^https?:\/\/\S+$/.test(s)) throw new Error(`${d.label} must be an http(s) address.`);
      if (d.type === "select" && !d.options!.includes(s)) throw new Error(`${d.label} must be one of: ${d.options!.join(", ")}.`);
      out[d.key] = s;
    }
  }
  return out;
}
