import type { Config } from "./config.ts";
import type { Store } from "./store.ts";

// Settings you can change on the Settings page. Each one starts from its .env variable (or a default),
// and a value saved on the page wins over .env until you reset it. Secrets are write-only: the page
// only learns whether one is set. Login, bot token, port and time zone stay in .env, because a wrong
// value on the page could lock you out or move the server.

export type SettingType = "int" | "text" | "url" | "secret" | "bool" | "choice";

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
  /** For "choice": the values and how the page names them. */
  options?: [string, string][];
  /** Default when neither the page nor .env sets it. */
  fallback: string | number | boolean;
}

export const MAIL_SLOTS = [1, 2, 3] as const;
export const WHATSAPP_SLOTS = [1, 2] as const;

export const GROUPS = ["General", "Triage", "Wakes", "Phone pings", ...WHATSAPP_SLOTS.map((n) => `WhatsApp ${n}`), ...MAIL_SLOTS.map((n) => `Mail ${n}`), "Calendar", "Todoist", "PoliTO"];

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
    key: "openrouterKey", env: "OPENROUTER_API_KEY", group: "Triage", type: "secret", fallback: "",
    label: "OpenRouter API key", help: "Jev, the model that sorts your messages, runs on OpenRouter. Without a key, nothing is sorted and Grok keeps its old schedule.",
  },
  {
    key: "triageMode", env: "TRIAGE_MODE", group: "Triage", type: "choice", fallback: "shadow",
    options: [["off", "Off"], ["shadow", "Shadow"], ["on", "On"]],
    label: "Mode", help: "Shadow: Jev sorts and logs, but the page and Grok work as before, so you can check its choices first. On: triage makes the cards and wakes Grok.",
  },
  {
    key: "jevModel", env: "JEV_MODEL", group: "Triage", type: "text", fallback: "typesafe/jev-1.14", placeholder: "typesafe/jev-1.14",
    label: "Jev model", help: "The OpenRouter model id. A pinned version keeps decisions steady.",
  },
  {
    key: "triageAbout", env: "TRIAGE_ABOUT", group: "Triage", type: "text", fallback: "",
    placeholder: "I'm a student at PoliTO. Anything from my family or about exams is important.",
    label: "About you", help: "A sentence or two Jev reads with every message: who you are, and the people or topics that always matter.",
  },
  {
    key: "triageReplyAt", env: "TRIAGE_REPLY_AT", group: "Triage", type: "int", min: 35, max: 100, unit: "%", fallback: 60,
    label: "Grok works on a chat at", help: "How sure Jev must be that a chat needs your reply or decision before Grok drafts it. Below that, down to 35%, you get a plain card instead.",
  },
  {
    key: "grokBot", env: "GROK_BOT", group: "Wakes", type: "text", fallback: "dashboard", placeholder: "dashboard",
    label: "Grok bot", help: "The bot that drafts replies and answers, by its grokdash id (BOT= in its config).",
  },
  {
    key: "wakeWait", env: "WAKE_WAIT", group: "Wakes", type: "int", min: 10, max: 1440, unit: "minutes", fallback: 60,
    label: "Other work waits", help: "Work that isn't urgent goes to a bot in one run once the oldest piece has waited this long, and the bot hasn't run for this long either.",
  },
  {
    key: "wakeGather", env: "WAKE_GATHER", group: "Wakes", type: "int", min: 0, max: 30, unit: "minutes", fallback: 3,
    label: "Urgent work gathers for", help: "Urgent work waits this long for more to arrive, then the bot runs once with everything queued for it, urgent or not.",
  },
  {
    key: "wakeMerge", env: "WAKE_MERGE", group: "Wakes", type: "int", min: 0, max: 120, unit: "minutes", fallback: 15,
    label: "After a run, urgent work waits", help: "So several urgent messages in a row cost one or two runs, not one each. Your taps never wait for this.",
  },
  {
    key: "weeklyRuns", env: "WEEKLY_RUNS", group: "Wakes", type: "int", min: 0, max: 1000, unit: "per week", fallback: 70,
    label: "Weekly runs", help: "Every bot's runs together, Monday to Sunday. Past this, only urgent work wakes a bot.",
  },
  {
    key: "ntfyTopic", env: "NTFY_TOPIC", group: "Phone pings", type: "secret", fallback: "",
    label: "ntfy topic", help: "Your phone gets a ping through ntfy when a PoliTO deadline is due tomorrow or a snoozed reminder comes back. Never for new messages: WhatsApp and mail already tell you. Subscribe to this topic in the ntfy app. A ping only says how many, never what the card says.",
  },
  {
    key: "ntfyServer", env: "NTFY_SERVER", group: "Phone pings", type: "url", fallback: "https://ntfy.sh", placeholder: "https://ntfy.sh",
    label: "ntfy server", help: "ntfy.sh is public, so pick a topic nobody can guess.",
  },
  {
    key: "dashboardUrl", env: "DASHBOARD_URL", group: "Phone pings", type: "url", fallback: "", placeholder: "https://your-machine.your-tailnet.ts.net:8443",
    label: "Dashboard address", help: "Tapping the ping opens this.",
  },
  ...WHATSAPP_SLOTS.flatMap((n): SettingDef[] => [
    {
      key: `whatsapp${n}Name`, env: `WAHA${n === 1 ? "" : n}_NAME`, group: `WhatsApp ${n}`, type: "text",
      fallback: n === 1 ? "WhatsApp" : "WhatsApp Business", placeholder: n === 1 ? "WhatsApp" : "WhatsApp Business",
      label: "Name", help: "Shown on cards from this number, so you can tell your numbers apart.",
    },
    {
      key: `whatsapp${n}Url`, env: `WAHA${n === 1 ? "" : n}_URL`, group: `WhatsApp ${n}`, type: "url", fallback: "",
      placeholder: `http://waha${n === 1 ? "" : n}:3000`,
      label: "WAHA address", help: `Where this number's WAHA bridge answers.${n === 1 ? "" : " Each number needs its own WAHA."} Empty turns it off. The dashboard only reads.`,
    },
    {
      key: `whatsapp${n}ApiKey`, env: `WAHA${n === 1 ? "" : n}_API_KEY`, group: `WhatsApp ${n}`, type: "secret", fallback: "",
      label: "WAHA API key", help: "The WAHA_API_KEY that this WAHA runs with.",
    },
  ]),
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
  options?: [string, string][];
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
    case "choice":
      if (typeof raw !== "string" || !def.options!.some(([v]) => v === raw)) {
        throw new SettingError(`${def.label} must be one of: ${def.options!.map(([, l]) => l).join(", ")}.`);
      }
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
