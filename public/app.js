// Grok Bot Dashboard, browser side. Plain JS, no build step.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (id, cls = "i") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

const ui = {
  state: null,
  tab: "today",
  filter: "all",
  open: new Set(),      // cards expanded on the phone
  writing: new Set(),   // cards with the Write field open
  snoozing: new Set(),  // cards with the snooze menu open
  editing: new Set(),   // drafts being edited
  text: new Map(),      // unsent text by field id, kept until it's sent or cancelled
  doneTodos: new Map(), // "bot|id" -> { todo, at } for the Undo row after ticking a to-do
  todoBusy: new Set(),  // "bot|id" with a request in flight
  archive: { items: [], more: false, q: "" },
};

// ---------- talking to the server ----------

// Every state request gets a number. A response older than one already shown is dropped,
// so a slow poll can't undo what a tap just changed. While a tap is on its way, polls are ignored
// altogether, and the tap's own answer always wins.
let seq = 0;
let shown = 0;
let mutating = 0;
let lastMutation = 0;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `The server answered ${res.status}.`), { status: res.status });
  return data;
}

function applyState(id, state) {
  if (id < shown) return;
  shown = id;
  ui.state = state;
  render();
}

async function load() {
  const id = ++seq;
  try {
    const state = await api("GET", "/api/ui/state");
    showBanner("");
    if (!mutating) applyState(id, state);
  } catch (err) {
    showBanner(`Can't reach the dashboard server: ${err.message} Retrying every 20 seconds.`);
  }
}

async function run(method, path, body) {
  mutating++;
  const mine = ++lastMutation;
  let failed = false;
  try {
    const data = await api(method, path, body);
    // Only the newest tap's answer is shown; an older tap finishing late would show stale state.
    if (data.state && mine === lastMutation) applyState(++seq, data.state);
    return data;
  } catch (err) {
    failed = true;
    toast(err.message);
    return null;
  } finally {
    mutating--;
    // After a refused tap, or when taps overlapped, fetch the real state once they've all settled.
    if (!mutating && (failed || mine !== lastMutation)) load();
  }
}

function showBanner(msg) {
  const b = $("#banner");
  b.textContent = msg;
  b.hidden = !msg;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// ---------- time formatting ----------

// Times show in the server's time zone (TZ), the same one the bots write the agenda in.
const tz = () => ui.state?.tz || undefined;
function parts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, stamp: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` };
}
const dayName = (d) => d.toLocaleDateString("en-GB", { weekday: "short", timeZone: tz() });
const localDay = (d) => parts(d).day;
const hhmm = (d) => parts(d).time;
const dayOfMonth = (d) => Number(parts(d).day.slice(8));
const nowStamp = () => parts(new Date()).stamp;

function when(ms) {
  const d = new Date(ms);
  const today = localDay(new Date());
  const y = new Date(Date.now() - 86400000);
  if (localDay(d) === today) return hhmm(d);
  if (localDay(d) === localDay(y)) return "Yesterday";
  return `${dayName(d)} ${dayOfMonth(d)}`;
}

function whenFull(ms) {
  const d = new Date(ms);
  return localDay(d) === localDay(new Date()) ? hhmm(d) : `${dayName(d)} ${dayOfMonth(d)} ${hhmm(d)}`;
}

function ago(ms) {
  if (!ms) return "No scan yet";
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "Updated just now";
  if (min < 60) return `Updated ${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `Updated ${h} h ago` : `Updated ${when(ms)}`;
}

const addDay = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** "2026-10-13" relative to the server's today. */
function dayLabel(day, today) {
  if (!day) return "";
  const diff = Math.round((Date.parse(day + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const d = new Date(day + "T12:00:00Z");
  const name = d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  return diff > 1 && diff < 7 ? name : `${name} ${d.getUTCDate()}`;
}

// ---------- rendering ----------

const botOf = (slug) => ui.state.bots.find((b) => b.slug === slug) || { slug, name: slug, color: "#5b5a55" };
const avatar = (slug) => {
  const b = botOf(slug);
  return `<span class="avatar" data-color="${esc(b.color)}" title="${esc(b.name)} bot">${esc((b.name || "?").charAt(0).toUpperCase())}</span>`;
};
const visible = (item) => ui.filter === "all" || item.bot === ui.filter;

/** Brand tile for where a card comes from, with the posting bot as a small badge when there are several bots. */
function brandTile(b, extra = "") {
  const mark = b.path
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${b.path}"/></svg>`
    : `<span class="letter" aria-hidden="true">${esc(b.letter)}</span>`;
  return `<span class="logo" data-color="${esc(b.color)}" title="${esc(b.name)}">${mark}${extra}</span>`;
}

function logo(item) {
  const b = brandFor(item.app, item.source) || brandFor("", item.title);
  if (!b) return avatar(item.bot);
  const bot = botOf(item.bot);
  const badge = ui.state.bots.length > 1
    ? `<span class="bot-badge" data-color="${esc(bot.color)}" title="${esc(bot.name)} bot">${esc((bot.name || "?").charAt(0).toUpperCase())}</span>`
    : "";
  return brandTile(b, badge);
}

function paintColors() {
  // The page's CSP forbids inline style attributes, so colors are set through the DOM.
  for (const el of $$("[data-color]")) el.style.background = el.dataset.color;
}

/** A selector that finds "the same" control after a re-render, so keyboard focus isn't lost. */
function focusKey(el) {
  if (!el || el === document.body) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const a = el.dataset;
  const attrs = ["act", "id", "option", "todo", "action", "until", "bot", "tab"].filter((k) => a[k] !== undefined);
  if (!attrs.length) return null;
  return attrs.map((k) => `[data-${k}="${CSS.escape(a[k])}"]`).join("");
}

function render() {
  if (!ui.state) return;
  const active = document.activeElement;
  const key = focusKey(active);
  const caret = active && "selectionStart" in active ? active.selectionStart : null;
  renderHeader();
  renderFilters();
  renderNeeds();
  renderTodos();
  renderAgenda();
  renderCatch();
  paintColors();
  if (key && document.activeElement !== active) {
    const again = document.querySelector(key);
    if (again) {
      again.focus({ preventScroll: true });
      if (caret != null && "setSelectionRange" in again) again.setSelectionRange(caret, caret);
    }
  }
}

function renderHeader() {
  const s = ui.state;
  const now = new Date();
  $("#full-date").textContent = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz() });
  const stamp = nowStamp();
  const next = s.agenda.find((e) => e.start.length > 10 && e.start.slice(0, 10) === s.today && e.start >= stamp);
  const short = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz() });
  $("#glance").innerHTML = next ? `${esc(short)} · Next <strong>${esc(next.start.slice(11, 16))}</strong> ${esc(next.title)}` : esc(short);
  // A bot that missed its run may still answer a refresh: the server already woke it once, and a tap wakes it again.
  const down = s.bots.filter((b) => b.offlineSince);
  const hooked = s.bots.filter((b) => b.hasWebhook);
  const allDown = hooked.length > 0 && hooked.every((b) => b.offlineSince);
  $("#offline").hidden = !down.length;
  $("#offline").textContent = down
    .map((b) => `${b.name} hasn't checked in since ${b.lastSeenAt ? whenFull(b.lastSeenAt) : "it was set up"}. ${b.hasWebhook ? "Tap Refresh to wake it." : "Taps wait for its next run."}`)
    .join(" ");
  const asked = s.bots.some((b) => b.refreshRequestedAt);
  const label = asked ? "Scan requested" : allDown ? "Bot offline" : ago(s.lastScanAt);
  $("#refresh-label").textContent = label;
  $("#fresh").textContent = label;
  $("#refresh").classList.toggle("busy", asked);
  const hooks = s.bots.filter((b) => b.hasWebhook).length;
  $("#foot").textContent = s.bots.length
    ? `${s.bots.length} bot${s.bots.length > 1 ? "s" : ""} connected. ${hooks ? "Taps reach the bots within seconds." : "No bot has a webhook yet, so taps wait for the next scheduled scan."}`
    : "No bot has posted yet. Set up the Dashboard bot from bot/README.md in the repo.";
}

function renderFilters() {
  const bots = ui.state.bots;
  if (ui.filter !== "all" && !bots.some((b) => b.slug === ui.filter)) ui.filter = "all";
  const open = ui.state.needs.filter((i) => i.status !== "closed");
  const chip = (slug, label, count, extra = "") =>
    `<button class="chip-filter${extra}" aria-pressed="${ui.filter === slug}" data-bot="${esc(slug)}">${label} <span class="count num">${count || ""}</span></button>`;
  $("#filters").innerHTML = bots.length < 2 ? "" :
    chip("all", "All", open.length, " all") +
    bots.map((b) => chip(b.slug, `${avatar(b.slug)}${esc(b.name)}`, open.filter((i) => i.bot === b.slug).length)).join("");
  $("#filters").hidden = bots.length < 2;
}

function cardActions(c) {
  const id = c.id;
  const write = `<button class="btn ghost" data-act="write" data-id="${id}">${icon("msg")}<span class="lbl">Write</span></button>`;
  const snooze = `<button class="btn ghost" data-act="snooze" data-id="${id}">${icon("clock")}<span class="lbl">Snooze</span></button>`;
  const dismiss = `<button class="btn ghost" data-act="dismiss" data-id="${id}" aria-label="Dismiss" title="Dismiss">${icon("x")}</button>`;
  const end = `<span class="end">${write}${snooze}${dismiss}</span>`;
  if (ui.editing.has(id)) {
    return `<button class="btn primary" data-act="send-edited" data-id="${id}">${icon("send")}Send to ${esc(short(c.draft.to))}</button>
      <button class="btn" data-act="cancel-edit" data-id="${id}">Cancel</button>`;
  }
  if (c.kind === "choice") {
    return c.options.map((o, i) =>
      `<button class="btn suggest${i === 0 ? " primary" : ""}" data-act="choose" data-id="${id}" data-option="${i}"${o.instruction ? ` title="${esc(o.instruction)}"` : ""}>${esc(o.label)}</button>`,
    ).join("") + end;
  }
  if (c.kind === "draft") {
    return `<button class="btn primary" data-act="send" data-id="${id}">${icon("send")}Send to ${esc(short(c.draft.to))}</button>
      <button class="btn" data-act="edit" data-id="${id}">${icon("pencil")}Edit</button>${end}`;
  }
  return `<button class="btn primary" data-act="done" data-id="${id}">${icon("check")}Mark done</button>${end}`;
}

/**
 * What an answer will make the bot do, shown when the instruction isn't just the button's words
 * with a little more detail. That's the case worth a second look before tapping, so it shows on collapsed cards too.
 */
function answersList(c) {
  if (c.kind !== "choice") return "";
  const rows = c.options.filter((o) => {
    if (!o.instruction) return false;
    const i = o.instruction.trim().toLowerCase();
    const l = o.label.trim().toLowerCase();
    // "Vote Tuesday" doing "Vote Tuesday in the Lab group poll" needs no explanation; anything else does.
    return !i.startsWith(l) || i.length > l.length + 40;
  });
  if (!rows.length) return "";
  return `<dl class="answers">${rows.map((o) => `<dt>${esc(o.label)}</dt><dd>${esc(o.instruction)}</dd>`).join("")}</dl>`;
}

/** Names in buttons are cut to fit a phone; the card shows the full one. */
const short = (name, max = 22) => (name.length > max ? name.slice(0, max - 1).trimEnd() + "…" : name);

/** The row that replaces a card while the bot works on it, with Undo during the undo window. */
function pendingRow(c) {
  const p = c.pendingAction;
  const bot = botOf(c.bot).name;
  const what = p.type === "send" ? `Sending your reply to ${c.draft?.to ?? "them"}` : p.type === "write" ? `"${p.text}"` : p.label;
  const detail = p.instruction && p.instruction !== p.label ? `<span class="will-do">${esc(bot)} will: ${esc(p.instruction)}</span>` : "";
  if (p.status === "queued") {
    const left = Math.max(0, Math.ceil((p.runAfter - Date.now()) / 1000));
    return `<div class="resolved" role="status"><span class="pending-dot"></span><span class="status"><strong>${esc(what)}</strong>${detail}<span class="line">Sending to ${esc(bot)} in <span class="num" data-countdown="${p.runAfter}">${left}</span>s</span></span><button class="btn" data-act="undo" data-action="${p.id}">Undo</button></div>`;
  }
  return `<div class="resolved" role="status"><span class="pending-dot"></span><span class="status"><strong>${esc(what)}</strong>${detail}<span class="line">${esc(bot)} is on it</span></span></div>`;
}

function writeForm(c, placeholder) {
  const fid = `w-${c.id}`;
  return `<form class="write" data-form="${c.id}"><label class="sr-only" for="${fid}">${esc(placeholder)}</label><input id="${fid}" placeholder="${esc(placeholder)}" autocomplete="off" maxlength="2000" value="${esc(ui.text.get(fid) ?? "")}"><button class="btn primary" aria-label="Send">${icon("send")}</button></form>`;
}

function renderCard(c) {
  const bot = botOf(c.bot).name;
  if (c.status === "closed") {
    return `<div class="resolved done" role="status"><span class="ok">${icon("check")}</span><span class="status"><strong>${esc(c.resolution || "Done")}</strong><br>${esc(c.title)}</span><button class="btn ghost" data-act="ack" data-id="${c.id}" aria-label="Hide">${icon("x")}</button></div>`;
  }
  if (c.status === "pending" && c.pendingAction) return pendingRow(c);
  const open = ui.open.has(c.id) || Boolean(c.urgent) || Boolean(c.error) || ui.editing.has(c.id) || ui.writing.has(c.id) || ui.snoozing.has(c.id);
  const did = `d-${c.id}`;
  const draft = c.kind === "draft" && c.draft
    ? ui.editing.has(c.id)
      ? `<label class="sr-only" for="${did}">Edit the reply</label><textarea class="draft-edit" id="${did}" maxlength="4000">${esc(ui.text.get(did) ?? c.draft.text)}</textarea>`
      : `<div class="draft-label">Draft reply to ${esc(c.draft.to)}${c.draft.channel ? ` on ${esc(c.draft.channel)}` : ""}</div><div class="draft">${esc(c.draft.text)}</div>`
    : "";
  const snooze = ui.snoozing.has(c.id)
    ? `<div class="menu"><span class="label">Snooze until</span>${ui.state.snoozeChoices.map((s) => `<button class="btn suggest" data-act="snooze-to" data-id="${c.id}" data-until="${s.until}">${esc(s.label)}</button>`).join("")}</div>`
    : "";
  const source = c.link ? `<a class="src" href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">${esc(c.source || "Open")}</a>` : `<span class="src">${esc(c.source)}</span>`;
  return `<article class="card${c.urgent ? " urgent" : ""}${open ? " open" : ""}" aria-labelledby="t-${c.id}">
    <div class="meta">${logo(c)}${source}<time class="num" title="${esc(whenFull(c.updatedAt))}">${when(c.updatedAt)}</time></div>
    ${c.urgent ? `<div class="flag-row"><span class="flag">Urgent · ${esc(c.urgent)}</span></div>` : ""}
    <h3 id="t-${c.id}"><button class="title-btn" data-act="expand" data-id="${c.id}" aria-expanded="${open}">${esc(c.title)}${icon("chev", "i more")}</button></h3>
    <div class="detail">${c.body ? `<p>${esc(c.body)}</p>` : ""}${c.context ? `<p class="context">${esc(c.context)}</p>` : ""}</div>
    ${answersList(c)}
    ${draft}
    ${c.error ? `<div class="error">${esc(c.error)}</div>` : ""}
    <div class="actions">${cardActions(c)}</div>
    ${ui.writing.has(c.id) ? writeForm(c, `Tell ${bot} what to do`) : ""}${snooze}
  </article>`;
}

function renderNeeds() {
  const list = ui.state.needs.filter(visible);
  const open = list.filter((c) => c.status !== "closed").length;
  $("#needs-count").textContent = open || "";
  $("#needs").innerHTML = list.length
    ? list.map(renderCard).join("")
    : `<div class="empty"><strong>Nothing needs you right now</strong>Questions from your bots show up here.</div>`;
}

function todoWhen(t, today) {
  const parts = [];
  if (t.due) {
    const time = t.due.length > 10 ? ` ${t.due.slice(11, 16)}` : "";
    const late = t.due.length > 10 ? t.due < nowStamp() : t.due.slice(0, 10) < today;
    parts.push({ text: (late ? "Overdue · " : "") + dayLabel(t.due.slice(0, 10), today) + time, late });
  }
  if (t.deadline) parts.push({ text: `Deadline ${dayLabel(t.deadline, today).toLowerCase()}`, late: t.deadline <= today });
  return parts;
}

const todoKey = (t) => `${t.bot}|${t.id}`;

function renderTodos() {
  const s = ui.state;
  const t = s.todos;
  const today = s.today;
  const todoBrand = t.source === "todoist" ? BRANDS.todoist : t.items.length && t.items.every((x) => x.app === t.items[0].app) ? brandFor(t.items[0].app, "") : null;
  $("#todo-source").innerHTML = t.source === "none" ? "" : todoBrand ? `${brandTile(todoBrand)}<span>From ${esc(todoBrand.name)}</span>` : "From your bots";
  const now = Date.now();
  for (const [k, v] of ui.doneTodos) if (now - v.at > 15000) ui.doneTodos.delete(k);
  const items = t.items.filter((x) => !ui.doneTodos.has(todoKey(x)));
  $("#todo-count").textContent = items.length || "";
  if (t.source === "none") {
    $("#todos").innerHTML = `<div class="empty-row"><strong>No to-do list connected.</strong> Set <code>TODOIST_TOKEN</code> on the server, or let a bot send your to-dos.</div>`;
    return;
  }
  const row = (x, done) => {
    const k = todoKey(x);
    const busy = ui.todoBusy.has(k) ? " disabled" : "";
    return `
    <div class="todo${done ? " is-done" : ""}">
      <button class="check p${x.priority}" data-act="todo" data-todo="${esc(k)}" aria-pressed="${done}" aria-label="${done ? "Completed" : "Complete"}: ${esc(x.content)}"${done ? " disabled" : busy}>${icon("check")}</button>
      <div class="body">
        <div class="t">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.content)}</a>` : esc(x.content)}</div>
        <div class="sub">${done
          ? `<span>Completed</span><button class="btn ghost undo" data-act="todo-undo" data-todo="${esc(k)}"${busy}>Undo</button>`
          : `<span class="prio p${x.priority}">P${x.priority}</span>${todoWhen(x, today).map((w) => `<span class="${w.late ? "late" : ""}">${esc(w.text)}</span>`).join("")}${x.project ? `<span>${esc(x.project)}</span>` : ""}`}</div>
      </div>
    </div>`;
  };
  const done = [...ui.doneTodos.values()].map((v) => row(v.todo, true));
  const body = done.join("") + items.map((x) => row(x, false)).join("");
  const more = t.hidden ? `${t.hidden} more without a date this week` : "Sorted by date, then priority";
  const link = t.source === "todoist" ? `<a href="https://app.todoist.com/app/today" target="_blank" rel="noopener noreferrer">Open Todoist</a>` : "";
  $("#todos").innerHTML =
    (t.error ? `<div class="empty-row"><strong>Todoist didn't answer.</strong> ${esc(t.error)}</div>` : "") +
    (body || `<div class="empty-row">Nothing due this week.</div>`) +
    `<div class="list-foot"><span>${esc(more)}</span>${link}</div>`;
}

function renderAgenda() {
  const s = ui.state;
  const tomorrow = addDay(s.today, 1);
  const stamp = nowStamp();
  let nextMarked = false;
  const endLabel = (e, date) => {
    if (!e.end) return "";
    if (e.end.slice(0, 10) === date) return e.end.length > 10 ? `until ${e.end.slice(11, 16)}` : "";
    return e.end.length > 10 ? `until ${dayLabel(e.end.slice(0, 10), s.today)} ${e.end.slice(11, 16)}` : `until ${dayLabel(e.end.slice(0, 10), s.today)}`;
  };
  const day = (label, date) => {
    const next = addDay(date, 1);
    // Every event that touches this day, including ones that started earlier.
    // A datetime end is exclusive (ending at 00:00 doesn't touch that day); a date-only end includes it.
    const touches = (e) => !e.end ? e.start.slice(0, 10) === date : e.end.length === 10 ? e.end >= date : e.end > `${date}T00:00:00`;
    const evs = s.agenda.filter((e) => e.start < next && (e.start.slice(0, 10) === date || touches(e)));
    const rows = evs.map((e) => {
      const startsToday = e.start.slice(0, 10) === date;
      const time = e.allDay || !startsToday ? (startsToday ? "All day" : "Ongoing") : e.start.slice(11, 16);
      const finish = e.end || e.start;
      const past = !e.allDay && finish.length > 10 && finish < stamp;
      const isNext = !nextMarked && date === s.today && startsToday && !e.allDay && e.start >= stamp;
      if (isNext) nextMarked = true;
      const end = endLabel(e, date);
      const where = [e.location, e.location ? end : end.charAt(0).toUpperCase() + end.slice(1)].filter(Boolean).join(", ");
      return `<div class="ev${past ? " past" : ""}${isNext ? " now" : ""}">
        <div class="when num">${esc(time)}</div>
        <div><div class="what">${esc(e.title)}${isNext ? ` <span class="now-label">Next</span>` : ""}</div>${where ? `<div class="where">${esc(where)}</div>` : ""}</div>
      </div>`;
    });
    return `<div class="day">${label}</div><div class="list">${rows.join("") || `<div class="empty-row">Nothing in the calendar.</div>`}</div>`;
  };
  $("#agenda").innerHTML = day("Today", s.today) + day("Tomorrow", tomorrow);
  const apps = [...new Set(s.agenda.map((e) => e.app).filter(Boolean))];
  const calBrand = apps.length === 1 ? brandFor(apps[0], "") : null;
  $("#agenda-source").innerHTML = calBrand ? `${brandTile(calBrand)}<span>From ${esc(calBrand.name)}</span>` : "";
}

function renderCatch() {
  const list = ui.state.catchup.filter(visible);
  $("#catch-count").textContent = list.filter((c) => c.status !== "closed").length || "";
  const openIds = new Set($$("#catchup details[open]").map((d) => d.dataset.id));
  $("#catchup").innerHTML = list.length
    ? list.map((c) => {
        const read = c.status === "closed";
        const pending = c.status === "pending" && c.pendingAction;
        const isOpen = openIds.has(String(c.id)) || ui.writing.has(c.id) || pending;
        return `<details class="catch${read ? " read" : ""}" data-id="${c.id}"${isOpen ? " open" : ""}>
          <summary data-act="toggle-catch" data-id="${c.id}">${logo(c)}<span class="ttl">${esc(c.title)}</span><span class="n num">${esc(c.countLabel)}</span>${icon("chev", "i chev")}</summary>
          <p class="gist">${esc(c.body)}</p>
          ${pending ? `<div class="catch-pending">${pendingRow(c)}</div>` : `
          ${ui.writing.has(c.id) ? writeForm(c, `Ask ${botOf(c.bot).name} about this`) : ""}
          <div class="actions">${read ? "" : `<button class="btn" data-act="read" data-id="${c.id}">${icon("check")}Mark as read</button>`}<button class="btn ghost" data-act="write" data-id="${c.id}">${icon("msg")}Ask about this</button></div>`}
        </details>`;
      }).join("")
    : `<div class="empty-row">All caught up.</div>`;
}

let archiveSeq = 0;
let archiveLoading = false;
async function loadArchive(append = false) {
  if (append && archiveLoading) return;
  if (!append) ui.archive = { items: [], more: false, q: ui.archive.q };
  archiveLoading = true;
  const seqId = ++archiveSeq;
  const q = $("#arch-q").value.trim();
  const offset = append ? ui.archive.items.length : 0;
  try {
    const res = await api("GET", `/api/ui/archive?q=${encodeURIComponent(q)}&offset=${offset}&bot=${encodeURIComponent(ui.filter)}`);
    if (seqId !== archiveSeq) return;
    ui.archive = { items: append ? [...ui.archive.items, ...res.items] : res.items, more: res.more, q };
    archiveLoading = false;
    renderArchive();
  } catch (err) {
    if (seqId === archiveSeq) archiveLoading = false;
    $("#archive").innerHTML = `<div class="empty-row"><strong>Couldn't load the archive.</strong> ${esc(err.message)}</div>`;
  }
}

function renderArchive() {
  const items = ui.archive.items;
  const q = ui.archive.q;
  $("#archive").innerHTML = items.length
    ? items.map((a) => {
        const why = a.status === "snoozed"
          ? `Snoozed until ${whenFull(a.snoozedUntil)}`
          : `${a.closedReason === "bot" ? `Closed by ${botOf(a.bot).name}: ` : ""}${a.resolution || a.closedReason} · ${when(a.closedAt)}`;
        const restore = a.closedReason === "action" ? "" : `<button class="btn" data-act="restore" data-id="${a.id}">Restore</button>`;
        const draft = a.draft ? `<div class="draft-label">Draft to ${esc(a.draft.to)}</div><div class="draft">${esc(a.draft.text)}</div>` : "";
        const link = a.link ? `<a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">Open the original</a>` : "";
        return `<details class="arch">
          <summary>${logo(a)}<div class="body"><div class="t">${esc(a.title)}</div><div class="why">${esc(why)}</div></div>${icon("chev", "i chev")}</summary>
          <div class="arch-detail">
            ${a.source ? `<p class="context">${esc(a.source)}</p>` : ""}${a.body ? `<p>${esc(a.body)}</p>` : ""}${a.context ? `<p class="context">${esc(a.context)}</p>` : ""}${draft}
            <div class="actions">${restore}${link}</div>
          </div>
        </details>`;
      }).join("") + (ui.archive.more ? `<div class="list-foot"><button class="btn" data-act="more-archive">Show older</button></div>` : "")
    : `<div class="empty arch-empty"><strong>${q ? "No matches" : "Nothing archived yet"}</strong>${q ? "Try another word, or clear the bot filter." : "Cards you finish, dismiss or snooze land here for 30 days."}</div>`;
  paintColors();
}

// ---------- interactions ----------

function setTab(tab) {
  ui.tab = tab;
  for (const t of $$("[data-tab]")) t.setAttribute("aria-selected", String(t.dataset.tab === tab));
  $("#view-today").hidden = tab !== "today";
  $("#view-archive").hidden = tab !== "archive";
  $("#view-title").textContent = tab === "today" ? "Today" : "Archive";
  if (tab === "archive") loadArchive();
  window.scrollTo({ top: 0 });
}

const item = (id) => [...ui.state.needs, ...ui.state.catchup].find((x) => x.id === Number(id));
const actOn = (id, body) => run("POST", `/api/ui/items/${id}/act`, body);

async function todoRequest(key, undo) {
  const [bot, ...rest] = key.split("|");
  ui.todoBusy.add(key);
  renderTodos();
  const res = await run("POST", "/api/ui/todos/complete", { bot, id: rest.join("|"), undo });
  ui.todoBusy.delete(key);
  return res;
}

document.addEventListener("input", (e) => {
  const id = e.target.id;
  if (id && /^[wd]-\d+$/.test(id)) ui.text.set(id, e.target.value);
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act], [data-tab], [data-bot]");
  if (!b || !ui.state || b.disabled) return;
  if (b.dataset.tab) return setTab(b.dataset.tab);
  if (b.dataset.bot) {
    ui.filter = b.dataset.bot;
    render();
    if (ui.tab === "archive") loadArchive();
    return;
  }
  const id = Number(b.dataset.id);
  const toggle = (set) => { set.has(id) ? set.delete(id) : set.add(id); };
  const c = id ? item(id) : null;
  switch (b.dataset.act) {
    case "expand": toggle(ui.open); render(); break;
    case "choose": {
      const n = Number(b.dataset.option);
      await actOn(id, { type: "choose", option: n, rev: c?.rev, label: c?.options[n]?.label });
      break;
    }
    case "send": await actOn(id, { type: "send", rev: c?.rev }); break;
    case "edit": ui.editing.add(id); render(); $(`#d-${id}`)?.focus(); break;
    case "cancel-edit": ui.editing.delete(id); ui.text.delete(`d-${id}`); render(); break;
    case "send-edited": {
      const text = ($(`#d-${id}`)?.value ?? "").trim();
      if (!text) return $(`#d-${id}`)?.focus();
      const ok = await actOn(id, { type: "send", text, rev: c?.rev });
      if (ok) { ui.editing.delete(id); ui.text.delete(`d-${id}`); render(); }
      break;
    }
    case "write":
      e.preventDefault();
      toggle(ui.writing);
      ui.snoozing.delete(id);
      render();
      $(`#w-${id}`)?.focus();
      break;
    case "snooze": toggle(ui.snoozing); ui.writing.delete(id); render(); break;
    case "snooze-to": {
      const ok = await actOn(id, { type: "snooze", until: Number(b.dataset.until) });
      if (ok) { ui.snoozing.delete(id); toast("Snoozed. It's in the archive until then."); }
      break;
    }
    case "done": await actOn(id, { type: "done" }); break;
    case "dismiss": if (await actOn(id, { type: "dismiss" })) toast("Dismissed. Restore it from the archive."); break;
    case "read": e.preventDefault(); await actOn(id, { type: "read" }); break;
    case "restore": if (await actOn(id, { type: "restore" })) loadArchive(); break;
    case "more-archive": loadArchive(true); break;
    case "undo": await run("POST", `/api/ui/actions/${b.dataset.action}/undo`, {}); break;
    case "ack": await run("POST", `/api/ui/items/${id}/ack`, {}); break;
    case "todo": {
      const key = b.dataset.todo;
      const t = ui.state.todos.items.find((x) => todoKey(x) === key);
      if (!t || ui.todoBusy.has(key)) return;
      ui.doneTodos.set(key, { todo: t, at: Date.now() });
      const ok = await todoRequest(key, false);
      if (!ok) ui.doneTodos.delete(key);
      renderTodos();
      break;
    }
    case "todo-undo": {
      const key = b.dataset.todo;
      if (ui.todoBusy.has(key)) return;
      const ok = await todoRequest(key, true);
      if (ok) ui.doneTodos.delete(key);
      renderTodos();
      break;
    }
  }
});

document.addEventListener("submit", async (e) => {
  const id = Number(e.target.dataset.form);
  if (!id) return;
  e.preventDefault();
  const input = $(`#w-${id}`);
  const text = input.value.trim();
  if (!text) return input.focus();
  const ok = await actOn(id, { type: "write", text, rev: item(id)?.rev });
  if (ok) {
    ui.writing.delete(id);
    ui.text.delete(`w-${id}`);
    render();
  }
});

$("#refresh").addEventListener("click", async () => {
  const data = await run("POST", "/api/ui/refresh", {});
  if (data) toast(data.webhooks ? "Asked the bots for a fresh scan." : "Scan requested. The bots pick it up on their next run.");
});

let searchTimer;
$("#arch-q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadArchive(), 200);
});

// Undo countdowns tick locally; the server state is refreshed when one runs out.
setInterval(() => {
  let expired = false;
  for (const el of $$("[data-countdown]")) {
    const left = Math.ceil((Number(el.dataset.countdown) - Date.now()) / 1000);
    if (left <= 0) expired = true;
    el.textContent = Math.max(0, left);
  }
  if (expired) load();
}, 1000);

// Poll faster while the bot is working on something you tapped.
function schedule() {
  const busy = ui.state && [...ui.state.needs, ...ui.state.catchup].some((i) => i.status === "pending");
  setTimeout(async () => {
    if (document.visibilityState === "visible") await load();
    schedule();
  }, busy ? 4000 : 20000);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });

load();
schedule();
