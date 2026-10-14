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
    .filter((u) => /^https?:\/\/\S+$/i.test(u));
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

/** The events of one iCal file that touch the days [from, to). */
export function eventsFromIcs(ics: string, from: string, to: string, tz: string, app: string): AgendaEvent[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const vtz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(vtz);
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const ve of root.getAllSubcomponents("vevent")) {
    const ev = new ICAL.Event(ve);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) masters.get(ex.uid)?.relateException(ex);

  const windowEnd = zonedToEpoch(`${to}T00:00:00`, tz);
  const out: AgendaEvent[] = [];
  for (const ev of masters.values()) {
    if (cancelled(ev.component)) continue;
    if (!ev.isRecurring()) {
      const o = occurrence(ev.startDate, ev.endDate, ev, tz, app);
      if (overlaps(o.start, o.end, from, to)) out.push(o);
      continue;
    }
    const it = ev.iterator();
    // A daily event for years is a long list; past the window nothing more can match.
    for (let i = 0, next = it.next(); next && i < 5000; i++, next = it.next()) {
      if (next.toJSDate().getTime() >= windowEnd + 86_400_000) break;
      const d = ev.getOccurrenceDetails(next);
      if (cancelled(d.item.component)) continue;
      const o = occurrence(d.startDate, d.endDate, d.item, tz, app);
      if (overlaps(o.start, o.end, from, to)) out.push(o);
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/** Fetch every calendar and return today's and tomorrow's events. Fails if any calendar fails, so the agenda never shows half a day. */
export async function readCalendars(urls: string[], now: number, tz: string, fetchImpl: Fetch = fetch): Promise<{ from: string; to: string; events: AgendaEvent[] }> {
  const from = localStamp(new Date(now), tz).slice(0, 10);
  const to = addDays(from, 2);
  const events: AgendaEvent[] = [];
  for (const [i, url] of urls.entries()) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
    // The address is a secret, so errors name the calendar by its position, never by its URL.
    if (!res.ok) throw new Error(`Calendar ${i + 1} answered ${res.status}${res.status === 404 ? ". Its secret address may have been reset" : ""}`);
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error(`Calendar ${i + 1} isn't an iCal file. Use the secret address in iCal format`);
    const app = /(^|\.)google\.com$/i.test(new URL(url).hostname) ? "googlecalendar" : "";
    events.push(...eventsFromIcs(text, from, to, tz, app));
  }
  return { from, to, events: events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)) };
}
