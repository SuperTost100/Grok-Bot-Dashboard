// Reads calendars from their secret iCal addresses (Google Calendar has one per calendar) and puts
// today's and tomorrow's events on the agenda. Read-only; recurring events and their exceptions included.

import ICAL from "ical.js";
import type { CalEvent } from "../store.ts";
import { addDays, localStamp, overlaps, zonedToEpoch } from "../time.ts";

type Fetch = typeof fetch;
export type AgendaEvent = Omit<CalEvent, "id" | "bot">;

/** Events on the agenda belong to this name, so a resync replaces only them. */
export const CALENDAR_OWNER = "calendar";

export function calendarUrls(raw: string): string[] {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((u) => u.replace(/^webcal:\/\//i, "https://"))
    .filter((u) => {
      try {
        return /^https?:$/.test(new URL(u).protocol);
      } catch {
        return false;
      }
    });
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An iCal time as the dashboard's wall-clock string: a date for all-day, a datetime in `tz` otherwise. */
function stamp(t: ICAL.Time, tz: string): string {
  if (t.isDate) return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  // A floating time (no zone) means the same clock time wherever you are.
  if (t.zone === ICAL.Timezone.localTimezone) return `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
  return localStamp(t.toJSDate(), tz);
}

function occurrence(start: ICAL.Time, end: ICAL.Time | null, item: ICAL.Event, tz: string, app: string): AgendaEvent {
  const s = stamp(start, tz);
  let e = end ? stamp(end, tz) : "";
  // iCal all-day ends are exclusive (a one-day event ends the next day); the dashboard's are inclusive.
  if (start.isDate && e) e = addDays(e, -1) > s ? addDays(e, -1) : "";
  if (e === s) e = "";
  return {
    title: (item.summary || "Busy").slice(0, 200),
    start: s,
    end: e,
    location: (item.location || "").slice(0, 200),
    allDay: start.isDate,
    app,
  };
}

const cancelled = (c: ICAL.Component) => String(c.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";

/** Repeats expanded per event, about 0.6 s of work. An hourly event from years ago can need more. */
const MAX_REPEATS = 100_000;

/**
 * The events of one iCal file that touch the days [from, to).
 * `skipped` counts repeating events too long to expand, so the page can say an agenda may be missing one.
 */
export function eventsFromIcs(ics: string, from: string, to: string, tz: string, app: string): { events: AgendaEvent[]; skipped: number } {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const vtz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(vtz);
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const ve of root.getAllSubcomponents("vevent")) {
    const ev = new ICAL.Event(ve);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }

  const windowEnd = zonedToEpoch(`${to}T00:00:00`, tz);
  const out: AgendaEvent[] = [];
  const add = (start: ICAL.Time, end: ICAL.Time | null, item: ICAL.Event) => {
    const o = occurrence(start, end, item, tz, app);
    if (overlaps(o.start, o.end, from, to)) out.push(o);
  };
  // A moved occurrence counts on the day it moved to, wherever its original date was.
  // Its original date is left out of the series below.
  const moved = new Map<string, Set<string>>();
  for (const ex of exceptions) {
    if (!masters.has(ex.uid)) continue;
    let set = moved.get(ex.uid);
    if (!set) moved.set(ex.uid, (set = new Set()));
    set.add(ex.recurrenceId.toUnixTime().toString());
    if (!cancelled(ex.component)) add(ex.startDate, ex.endDate, ex);
  }
  let skipped = 0;
  for (const ev of masters.values()) {
    if (cancelled(ev.component)) continue;
    if (!ev.isRecurring()) {
      add(ev.startDate, ev.endDate, ev);
      continue;
    }
    const skip = moved.get(ev.uid);
    const it = ev.iterator();
    let n = 0;
    for (let next = it.next(); next; next = it.next()) {
      if (++n > MAX_REPEATS) {
        skipped++;
        break;
      }
      // Past the window (with a day's margin for time zones), nothing more can match.
      if (next.toJSDate().getTime() >= windowEnd + 86_400_000) break;
      // An occurrence moved on its own was added above, on the day it moved to.
      if (skip?.has(next.toUnixTime().toString())) continue;
      // getOccurrenceDetails applies changes made to "this and all future" occurrences.
      const d = ev.getOccurrenceDetails(next);
      if (d.item !== ev && cancelled(d.item.component)) continue;
      add(d.startDate, d.endDate, d.item);
    }
  }
  return { events: out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)), skipped };
}

/** Fetch every calendar and return today's and tomorrow's events. Fails if any calendar fails, so the agenda never shows half a day. */
export async function readCalendars(
  urls: string[],
  now: number,
  tz: string,
  fetchImpl: Fetch = fetch,
): Promise<{ from: string; to: string; events: AgendaEvent[]; skipped: number }> {
  const from = localStamp(new Date(now), tz).slice(0, 10);
  const to = addDays(from, 2);
  const events: AgendaEvent[] = [];
  let skipped = 0;
  for (const [i, url] of urls.entries()) {
    // The address is a secret, and fetch errors quote it. So errors name the calendar by its position
    // and give only a short reason, never the message of the error underneath.
    const name = `Calendar ${i + 1}`;
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
      text = await res.text();
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const why = e.name === "TimeoutError" ? "didn't answer in time" : e.cause?.code === "ENOTFOUND" ? "has a server name that doesn't exist" : "couldn't be reached";
      throw new Error(`${name} ${why}. Check its address.`);
    }
    if (!res.ok) throw new Error(`${name} answered ${res.status}${res.status === 404 ? ". Its secret address may have been reset" : ""}.`);
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error(`${name} isn't an iCal file. Use the secret address in iCal format.`);
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      // calendarUrls only lets through addresses that parse.
    }
    let parsed: ReturnType<typeof eventsFromIcs>;
    try {
      parsed = eventsFromIcs(text, from, to, tz, /(^|\.)google\.com$/i.test(host) ? "googlecalendar" : "");
    } catch {
      throw new Error(`${name} couldn't be read: the iCal file is broken.`);
    }
    events.push(...parsed.events);
    skipped += parsed.skipped;
  }
  return { from, to, events: events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)), skipped };
}
