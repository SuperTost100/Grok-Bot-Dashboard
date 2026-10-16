// Runs the sources the dashboard reads itself, each on its own beat, and keeps their status for the
// Settings page and the banner. Settings are read on every run, so a change applies at the next one.

import type { Settings } from "../settings.ts";
import { MAIL_SLOTS, WHATSAPP_SLOTS } from "../settings.ts";
import type { Store } from "../store.ts";
import { Waha, readWhatsApp } from "./whatsapp.ts";
import { parseHost, readMailbox } from "./mail.ts";
import { CALENDAR_OWNER, calendarUrls, readCalendars } from "./calendar.ts";

export interface SourceStatus {
  /** Settings group it belongs to, like "WhatsApp" or "Mail 1". */
  group: string;
  /** Configured and switched on. */
  on: boolean;
  ok: boolean;
  text: string;
  /** For WhatsApp: which number. */
  slot?: number;
  /** For WhatsApp: a QR code is up, waiting to be scanned. */
  needsQr?: boolean;
  /** For WhatsApp: not linked and no code showing; the page offers a new one. */
  needsLink?: boolean;
}

interface Track {
  group: string;
  everyMs: number;
  /** The settings the last run started with. A run with other settings starts fresh. */
  sig: string;
  /** Settings changed while a run was going: run again with the new ones when it ends. */
  again: boolean;
  lastRun: number;
  lastOk: number | null;
  failingSince: number | null;
  error: string;
  note: string;
  running: Promise<void> | null;
}

/** Network and login errors in words, instead of codes like ENOTFOUND. */
export function plainError(err: unknown): string {
  const e = err as Error & { code?: string; hostname?: string; authenticationFailed?: boolean; responseText?: string };
  const msg = e?.message || String(err);
  if (e?.authenticationFailed || /AUTHENTICATIONFAILED|invalid credentials|LOGIN failed/i.test(`${msg} ${e?.responseText ?? ""}`)) {
    return "The server refused the login or password.";
  }
  if (e?.code === "ENOTFOUND" || /ENOTFOUND/.test(msg)) return `Can't find the server${e?.hostname ? ` ${e.hostname}` : ""}. Check its name.`;
  if (e?.code === "ECONNREFUSED" || /ECONNREFUSED/.test(msg)) return "The server refused the connection. Check the address and port.";
  if (/ETIMEDOUT|timed? ?out|TimeoutError/i.test(`${e?.code ?? ""} ${e?.name ?? ""} ${msg}`)) return "The server didn't answer in time.";
  if (/fetch failed/i.test(msg)) return "Couldn't connect. Check the address.";
  // A library may quote the address it called, and some addresses (iCal) are secrets.
  return msg.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address]").slice(0, 300);
}

// A source that keeps failing this long shows in the banner on Today. Shorter blips only show on Settings.
const BANNER_AFTER_MS = 10 * 60_000;

export interface Sources {
  /** Start the runs that are due. Call every second or so. */
  tick(): void;
  /** Run every source now, like after Refresh. */
  refresh(): Promise<void>;
  status(): SourceStatus[];
  /** Problems worth a banner on Today. */
  problems(): string[];
  /** When every source that's on was last read without an error: the oldest of those reads. */
  lastRead(): number | null;
  waha(slot: number): Waha | null;
  /** Show a new QR code for a WhatsApp number. */
  link(slot: number): Promise<void>;
  /** Whether iCal addresses are set, so the agenda comes from them instead of from bots. */
  calendarOn(): boolean;
}

export function createSources(
  settings: Settings,
  store: Store,
  tz: string,
  log: (msg: string) => void,
  onNew: (count: number) => void = () => {},
): Sources {
  const tracks = new Map<string, Track>();
  const track = (group: string, everyMs: number) => {
    let t = tracks.get(group);
    if (!t) tracks.set(group, (t = { group, everyMs, sig: "", again: false, lastRun: 0, lastOk: null, failingSince: null, error: "", note: "", running: null }));
    return t;
  };

  const waha = (n: number) => {
    const url = settings.str(`whatsapp${n}Url`);
    const key = settings.str(`whatsapp${n}ApiKey`);
    return url && key ? new Waha(url, key) : null;
  };

  const mailAccount = (n: number) => {
    const where = parseHost(settings.str(`mail${n}Host`));
    const user = settings.str(`mail${n}User`);
    const password = settings.str(`mail${n}Password`);
    if (!settings.str(`mail${n}Host`) || !user || !password) return null;
    if (!where) return { error: "The IMAP server must look like imap.example.com or imap.example.com:993." };
    return { slot: n, name: settings.str(`mail${n}Name`) || `Mail ${n}`, host: where.host, port: where.port, user, password };
  };

  // Each source: its group, how often it runs, the settings it runs with, and the run itself (null when it's off).
  type Job = { group: string; everyMs: number; sig: string; run: (() => Promise<string>) | null };
  const sigOf = (keys: string[]) => JSON.stringify(keys.map((k) => settings.get(k)));
  function jobs(): Job[] {
    const list: Job[] = [];
    for (const n of WHATSAPP_SLOTS) {
      const wa = waha(n);
      const keys = [`whatsapp${n}Url`, `whatsapp${n}ApiKey`];
      const waSig = sigOf(keys);
      list.push({
        group: `WhatsApp ${n}`,
        // While a QR code is up, check often so the page shows the link as soon as you scan.
        everyMs: tracks.get(`WhatsApp ${n}`)?.note.startsWith("wa:") ? 10_000 : 60_000,
        sig: waSig,
        run: wa &&
          (async () => {
            const r = await readWhatsApp(wa, store, n, () => sigOf(keys) === waSig);
            if ("waiting" in r) return `wa:${r.waiting}`;
            if (r.added) onNew(r.added);
            return "";
          }),
      });
    }
    for (const n of MAIL_SLOTS) {
      const a = mailAccount(n);
      const keys = [`mail${n}Host`, `mail${n}User`, `mail${n}Password`];
      const mailSig = sigOf(keys);
      list.push({
        group: `Mail ${n}`,
        everyMs: 120_000,
        sig: mailSig,
        run: a &&
          (async () => {
            if ("error" in a) throw new Error(a.error);
            const added = await readMailbox(a, store, () => sigOf(keys) === mailSig);
            if (added) onNew(added);
            return "";
          }),
      });
    }
    const urls = calendarUrls(settings.str("calendarUrls"));
    const calSig = sigOf(["calendarUrls"]);
    list.push({
      group: "Calendar",
      everyMs: 15 * 60_000,
      sig: calSig,
      run: urls.length
        ? async () => {
            const { from, to, events, skipped } = await readCalendars(urls, store.now(), tz);
            // The addresses changed while this run fetched the old ones: its agenda is out of date.
            if (sigOf(["calendarUrls"]) !== calSig) return "";
            store.replaceEvents(CALENDAR_OWNER, from, to, events, false);
            const note = `${events.length} event${events.length === 1 ? "" : "s"} today and tomorrow`;
            return skipped ? `${note}. ${skipped} repeating event${skipped === 1 ? " repeats" : "s repeat"} too often to show` : note;
          }
        : null,
    });
    return list;
  }

  function start(job: Job): Promise<void> {
    const t = track(job.group, job.everyMs);
    if (t.running) {
      if (job.sig !== t.sig) t.again = true;
      return t.running;
    }
    if (!job.run) return Promise.resolve();
    if (job.sig !== t.sig) {
      // New settings: old errors and notes belong to the old ones.
      Object.assign(t, { sig: job.sig, lastOk: null, failingSince: null, error: "", note: "" });
    }
    t.lastRun = store.now();
    t.running = job
      .run()
      .then((note) => {
        if (t.error) log(`${job.group}: works again`);
        t.error = "";
        t.failingSince = null;
        t.note = note;
        t.lastOk = store.now();
      })
      .catch((err) => {
        const msg = plainError(err);
        if (msg !== t.error) log(`${job.group}: ${msg}`);
        t.error = msg;
        t.failingSince ??= store.now();
      })
      .finally(() => {
        t.running = null;
        if (t.again) {
          t.again = false;
          const latest = jobs().find((j) => j.group === job.group);
          if (latest) void start(latest);
        }
      });
    return t.running;
  }

  const ago = (ms: number) => {
    const min = Math.round((store.now() - ms) / 60_000);
    return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
  };

  return {
    tick() {
      const now = store.now();
      for (const job of jobs()) {
        const t = track(job.group, job.everyMs);
        if (!job.run) {
          // Switched off: forget the old state so switching on starts clean, but not while a run is still going.
          if (!t.running) tracks.delete(job.group);
          continue;
        }
        // After a failure, wait a little longer each time, up to 15 minutes, so a dead server isn't hammered.
        const wait = t.failingSince ? Math.min(15 * 60_000, Math.max(job.everyMs, (now - t.failingSince) / 2)) : job.everyMs;
        if (now - t.lastRun >= wait) void start(job);
      }
    },
    async refresh() {
      await Promise.all(jobs().map(start));
    },
    status() {
      return jobs().map((job) => {
        const t = tracks.get(job.group);
        if (!job.run) return { group: job.group, on: false, ok: true, text: "Off" };
        if (!t || t.sig !== job.sig || (!t.lastOk && !t.error)) return { group: job.group, on: true, ok: true, text: "Connecting…" };
        const slot = job.group.startsWith("WhatsApp ") ? Number(job.group.slice(9)) : undefined;
        if (t.error) return { group: job.group, slot, on: true, ok: false, text: t.error };
        if (t.note === "wa:SCAN_QR_CODE") return { group: job.group, slot, on: true, ok: false, text: "Not linked yet. Scan the QR code below with WhatsApp on your phone.", needsQr: true };
        if (t.note === "wa:STARTING") return { group: job.group, slot, on: true, ok: true, text: "Getting a QR code from WhatsApp…" };
        if (t.note.startsWith("wa:")) return { group: job.group, slot, on: true, ok: false, text: "Not linked. The last QR code expired unscanned.", needsLink: true };
        const linked = slot ? store.getState(`whatsapp:slot${slot}:linked`) : null;
        const who = linked && /^\d+$/.test(linked) ? `Linked to +${linked}. ` : "";
        return { group: job.group, slot, on: true, ok: true, text: `${who}Read ${ago(t.lastOk!)}${t.note ? `. ${t.note}` : ""}` };
      });
    },
    problems() {
      const now = store.now();
      const out: string[] = [];
      for (const t of tracks.values()) {
        if (t.failingSince && now - t.failingSince > BANNER_AFTER_MS) out.push(`${t.group} can't be read: ${t.error}`);
        else if (t.note.startsWith("wa:") && t.note !== "wa:STARTING") out.push(`${t.group} isn't linked. Open Settings to link it.`);
      }
      return out;
    },
    lastRead() {
      const reads = jobs().filter((j) => j.run).map((j) => tracks.get(j.group)).map((t) => t?.lastOk ?? null);
      return reads.length && reads.every((r) => r !== null) ? Math.min(...(reads as number[])) : null;
    },
    waha,
    async link(slot) {
      const wa = waha(slot);
      if (!wa) throw new Error("This WhatsApp number is off. Set its WAHA address and API key first.");
      await wa.link();
      const t = tracks.get(`WhatsApp ${slot}`);
      if (t) t.note = "wa:STARTING";
      // Read right after, so the page learns when the code is up.
      const job = jobs().find((j) => j.group === `WhatsApp ${slot}`);
      if (job) void start(job);
    },
    calendarOn: () => calendarUrls(settings.str("calendarUrls")).length > 0,
  };
}
