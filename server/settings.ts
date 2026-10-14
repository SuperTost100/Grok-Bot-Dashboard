import type { Config } from "./config.ts";
import type { Store } from "./store.ts";

// Settings you can change on the Settings page. Each one starts from its .env variable (or a default),
// and a value saved on the page wins over .env until you reset it. Secrets are write-only: the page
// only learns whether one is set. Login, bot token, port and time zone stay in .env, because a wrong
// value on the page could lock you out or move the server.

export type SettingType = "int" | "text" | "url" | "secret" | "bool";

export interface SettingDef {
  key: string;
  env: string;
  group: string;
  label: string;
  help: string;
  type: SettingType;
  min?: number;
  max?: number;
  unit?: string;
  placeholder?: string;
  /** Default when neither the page nor .env sets it. */
  fallback: string | number | boolean;
}

export const MAIL_SLOTS = [1, 2, 3] as const;

export const GROUPS = ["General", "WhatsApp", ...MAIL_SLOTS.map((n) => `Mail ${n}`), "Calendar", "Todoist", "PoliTO"];

export const DEFS: SettingDef[] = [
  {
    key: "undoSeconds", env: "UNDO_SECONDS", group: "General", type: "int", min: 0, max: 60, unit: "seconds", fallback: 5,
    label: "Undo window", help: "How long a tap waits before it goes to the bot.",
  },
  {
    key: "archiveDays", env: "ARCHIVE_DAYS", group: "General", type: "int", min: 1, max: 365, unit: "days", fallback: 30,
    label: "Archive", help: "How long closed cards stay searchable.",
  },
  {
    key: "backupDays", env: "BACKUP_DAYS", group: "General", type: "int", min: 0, max: 90, unit: "days", fallback: 7,
    label: "Daily backups", help: "Backups kept in data/backups. 0 turns them off.",
  },
  {
    key: "whatsappUrl", env: "WAHA_URL", group: "WhatsApp", type: "url", fallback: "", placeholder: "http://waha:3000",
    label: "WAHA address", help: "Where the WAHA WhatsApp bridge answers. Empty turns WhatsApp off. The dashboard only reads.",
  },
  {
    key: "whatsappApiKey", env: "WAHA_API_KEY", group: "WhatsApp", type: "secret", fallback: "",
    label: "WAHA API key", help: "The WAHA_API_KEY that WAHA runs with.",
  },
  ...MAIL_SLOTS.flatMap((n): SettingDef[] => [
    {
      key: `mail${n}Name`, env: `MAIL${n}_NAME`, group: `Mail ${n}`, type: "text", fallback: "", placeholder: n === 1 ? "PoliTO" : n === 2 ? "Work" : "Gmail",
      label: "Name", help: "Shown on cards from this mailbox.",
    },
    {
      key: `mail${n}Host`, env: `MAIL${n}_HOST`, group: `Mail ${n}`, type: "text", fallback: "", placeholder: "imap.gmail.com",
      label: "IMAP server", help: "Port 993 with TLS. Add :port for another one. Empty turns this mailbox off.",
    },
    {
      key: `mail${n}User`, env: `MAIL${n}_USER`, group: `Mail ${n}`, type: "text", fallback: "", placeholder: "you@example.com",
      label: "Login", help: "Usually the full address.",
    },
    {
      key: `mail${n}Password`, env: `MAIL${n}_PASSWORD`, group: `Mail ${n}`, type: "secret", fallback: "",
      label: "Password", help: "For Gmail, an app password (Google Account > Security > App passwords), not your normal one.",
    },
  ]),
  {
    key: "calendarUrls", env: "CALENDAR_URLS", group: "Calendar", type: "secret", fallback: "",
    label: "Secret iCal addresses",
    help: "In Google Calendar: Settings > your calendar > Integrate calendar > Secret address in iCal format. For several calendars, put spaces between the addresses.",
  },
  {
    key: "todoistToken", env: "TODOIST_TOKEN", group: "Todoist", type: "secret", fallback: "",
    label: "API token", help: "From Todoist Settings > Integrations > Developer. Without it, a bot sends your to-dos.",
  },
  {
    key: "todoistFilter", env: "TODOIST_FILTER", group: "Todoist", type: "text", fallback: "", placeholder: "today | overdue | p1",
    label: "Filter", help: "Show only tasks matching a Todoist filter. Empty shows all active tasks.",
  },
  {
    key: "areadidatticaUrl", env: "AREADIDATTICA_URL", group: "PoliTO", type: "url", fallback: "", placeholder: "http://areadidattica:8789",
    label: "areadidattica address", help: "Where areadidattica answers. Empty turns PoliTO avvisi off.",
  },
  {
    key: "areadidatticaToken", env: "AREADIDATTICA_TOKEN", group: "PoliTO", type: "secret", fallback: "",
    label: "areadidattica token", help: "The API_TOKEN from areadidattica's .env.",
  },
];

export type SettingValue = string | number | boolean;

export interface SettingView {
  key: string;
  group: string;
  label: string;
  help: string;
  type: SettingType;
  min?: number;
  max?: number;
  unit?: string;
  placeholder?: string;
  /** null for secrets: the page never sees them. */
  value: SettingValue | null;
  /** Whether a secret has a value. */
  set: boolean;
  /** Where the value comes from: saved on the page, .env, or the built-in default. */
  source: "page" | "env" | "default";
}

export class SettingError extends Error {}

/** Check and convert what the page sent. Throws SettingError with a message for the page. */
function parse(def: SettingDef, raw: unknown): SettingValue {
  switch (def.type) {
    case "int": {
      const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isInteger(n) || n < def.min! || n > def.max!) {
        throw new SettingError(`${def.label} must be a whole number from ${def.min} to ${def.max}.`);
      }
      return n;
    }
    case "bool":
      if (typeof raw !== "boolean") throw new SettingError(`${def.label} must be on or off.`);
      return raw;
    default: {
      if (typeof raw !== "string") throw new SettingError(`${def.label} must be text.`);
      const s = raw.trim();
      if (s.length > 2000) throw new SettingError(`${def.label} is longer than 2000 characters.`);
      if (def.type === "url" && s && !/^https?:\/\/[^\s]+$/i.test(s)) throw new SettingError(`${def.label} must be an http:// or https:// address.`);
      return s;
    }
  }
}

export class Settings {
  store: Store;
  /** What each setting is without a page value: .env as loadConfig read it, or the default. */
  base = new Map<string, SettingValue>();
  envSet = new Set<string>();
  listeners: ((keys: string[]) => void)[] = [];

  constructor(store: Store, config: Config, env: NodeJS.ProcessEnv = process.env) {
    this.store = store;
    const fromConfig = config as unknown as Record<string, SettingValue | undefined>;
    for (const def of DEFS) {
      const raw = (env[def.env] ?? "").trim();
      if (raw) this.envSet.add(def.key);
      // Settings that loadConfig knows were checked at startup; newer ones are checked here.
      const value = fromConfig[def.key] ?? (raw ? parse(def, def.type === "bool" ? raw === "1" || raw === "true" : raw) : def.fallback);
      this.base.set(def.key, value);
    }
  }

  def(key: string): SettingDef {
    const d = DEFS.find((x) => x.key === key);
    if (!d) throw new SettingError(`There's no setting called "${key}".`);
    return d;
  }

  saved(key: string): SettingValue | undefined {
    const raw = this.store.getSetting(key);
    return raw == null ? undefined : (JSON.parse(raw) as SettingValue);
  }

  get(key: string): SettingValue {
    const def = this.def(key);
    return this.saved(key) ?? this.base.get(def.key)!;
  }

  int(key: string): number {
    return this.get(key) as number;
  }

  str(key: string): string {
    return this.get(key) as string;
  }

  list(): SettingView[] {
    return DEFS.map((def) => {
      const value = this.get(def.key);
      const source = this.saved(def.key) !== undefined ? "page" : this.envSet.has(def.key) ? "env" : "default";
      const { env: _env, fallback: _fallback, ...rest } = def;
      return { ...rest, value: def.type === "secret" ? null : value, set: value !== "" && value !== false, source };
    });
  }

  /** Save values from the page. null resets a setting to .env or its default. All or nothing. */
  update(patch: Record<string, unknown>): string[] {
    const parsed = Object.entries(patch).map(([key, raw]) => {
      const def = this.def(key);
      return [key, raw === null ? null : parse(def, raw)] as const;
    });
    const changed: string[] = [];
    this.store.tx(() => {
      for (const [key, value] of parsed) {
        const before = this.get(key);
        this.store.setSetting(key, value === null ? null : JSON.stringify(value));
        if (this.get(key) !== before) changed.push(key);
      }
    });
    if (changed.length) for (const fn of this.listeners) fn(changed);
    return changed;
  }

  onChange(fn: (keys: string[]) => void) {
    this.listeners.push(fn);
  }
}
