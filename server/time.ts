// Dates are stored as wall-clock strings in the dashboard's time zone (TZ):
// "YYYY-MM-DD" for all-day things, "YYYY-MM-DDTHH:MM:SS" for times. String order is time order.

export function localStamp(d: Date, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parse a date or datetime from a bot or from Todoist. Returns the wall-clock string in `tz`,
 * or null when it isn't a real date ("2026-02-30", "25:00").
 */
export function parseWhen(s: string, tz: string): string | null {
  const m = WHEN.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, off] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const real = new Date(Date.UTC(year, month - 1, day));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) return null;
  if (h === undefined) return `${y}-${mo}-${d}`;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec ?? 0) > 59) return null;
  const clock = `${y}-${mo}-${d}T${h}:${mi}:${sec ?? "00"}`;
  if (!off) return clock;
  if (off !== "Z") {
    const [oh, om] = [Number(off.slice(1, 3)), Number(off.slice(-2))];
    if (oh > 14 || om > 59) return null;
  }
  const instant = new Date(clock + (off === "Z" ? "Z" : off.length === 5 ? off.slice(0, 3) + ":" + off.slice(3) : off));
  return Number.isNaN(instant.getTime()) ? null : localStamp(instant, tz);
}

/** The instant a wall-clock time in `tz` happens, in Unix ms. */
export function zonedToEpoch(stamp: string, tz: string): number {
  const guess = Date.parse(stamp + "Z");
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const shown = Date.parse(localStamp(new Date(t), tz) + "Z");
    t += guess - shown;
  }
  return t;
}

/** Snooze presets computed in the dashboard's time zone, so "Tomorrow 9:00" means 9:00 where you are. */
export function snoozeChoices(now: number, tz: string): { label: string; until: number }[] {
  const stamp = localStamp(new Date(now), tz);
  const today = stamp.slice(0, 10);
  const hour = Number(stamp.slice(11, 13));
  const weekday = new Date(today + "T12:00:00Z").getUTCDay();
  const at = (day: string, h: number) => zonedToEpoch(`${day}T${String(h).padStart(2, "0")}:00:00`, tz);
  const list = [{ label: "In 1 hour", until: now + 3_600_000 }];
  if (hour < 18) list.push({ label: "Tonight 19:00", until: at(today, 19) });
  list.push({ label: "Tomorrow 9:00", until: at(addDays(today, 1), 9) });
  const toMonday = ((8 - weekday) % 7) || 7;
  if (toMonday > 1) list.push({ label: "Monday 9:00", until: at(addDays(today, toMonday), 9) });
  return list;
}

/**
 * Whether an event touches the window [from, to) of dates. A datetime end is exclusive
 * (ending at 00:00 doesn't touch that day); a date-only end includes that day. Same rule as the SQL in store.ts.
 */
export function overlaps(start: string, end: string, from: string, to: string): boolean {
  if (!(start < to)) return false;
  if (!end) return start >= from;
  return end.length === 10 ? end >= from : end > `${from}T00:00:00`;
}

/** The latest of the daily run times `slots` ("HH:MM" in `tz`) at or before `now`, in Unix ms. */
export function lastSlot(now: number, slots: string[], tz: string): number | null {
  const today = localStamp(new Date(now), tz).slice(0, 10);
  let best: number | null = null;
  for (const day of [today, addDays(today, -1)]) {
    for (const s of slots) {
      const t = zonedToEpoch(`${day}T${s}:00`, tz);
      if (t <= now && (best === null || t > best)) best = t;
    }
  }
  return best;
}
