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
  doneTodos: new Map(), // id -> { todo, at } for the Undo row after ticking a to-do
  busy: false,
  refreshAskedAt: 0,
};

// ---------- talking to the server ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

async function load() {
  try {
    ui.state = await api("GET", "/api/ui/state");
    showBanner("");
    render();
  } catch (err) {
    showBanner(`Can't reach the dashboard server: ${err.message} Retrying every 20 seconds.`);
  }
}

async function run(method, path, body) {
  try {
    const data = await api(method, path, body);
    if (data.state) {
      ui.state = data.state;
      render();
    }
    return data;
  } catch (err) {
    toast(err.message);
    await load();
    return null;
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
    timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const dayName = (d) => d.toLocaleDateString("en-GB", { weekday: "short", timeZone: tz() });
const localDay = (d) => parts(d).day;
const hhmm = (d) => parts(d).time;
const dayOfMonth = (d) => Number(parts(d).day.slice(8));

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

/** "2026-10-13" or "2026-10-13T14:30:00" relative to the server's today. */
function dayLabel(day, today) {
  if (!day) return "";
  const diff = Math.round((Date.parse(day + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const d = new Date(day + "T12:00:00Z");
  return diff > 1 && diff < 7 ? d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }) : `${d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

function snoozeChoices() {
  const now = new Date();
  const at = (days, h) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d; };
  const list = [{ label: "In 1 hour", until: new Date(now.getTime() + 3600000) }];
  if (now.getHours() < 18) list.push({ label: "Tonight 19:00", until: at(0, 19) });
  list.push({ label: "Tomorrow 9:00", until: at(1, 9) });
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  if (toMonday > 1) list.push({ label: "Monday 9:00", until: at(toMonday, 9) });
  return list;
}

// ---------- rendering ----------

const botOf = (slug) => ui.state.bots.find((b) => b.slug === slug) || { slug, name: slug, color: "#5b5a55" };
const avatar = (slug) => {
  const b = botOf(slug);
  return `<span class="avatar" data-color="${esc(b.color)}" title="${esc(b.name)} bot">${esc((b.name || "?").charAt(0).toUpperCase())}</span>`;
};
const visible = (item) => ui.filter === "all" || item.bot === ui.filter;

function paintColors() {
  // The page's CSP forbids inline style attributes, so colors are set through the DOM.
  for (const el of $$("[data-color]")) el.style.background = el.dataset.color;
}

function render() {
  if (!ui.state) return;
  // Keep whatever is being typed when the page re-renders under it.
  const typing = $$("input[id^='w-'], textarea[id^='d-']").map((el) => ({ id: el.id, value: el.value, focused: el === document.activeElement, pos: el.selectionStart }));
  renderHeader();
  renderFilters();
  renderNeeds();
  renderTodos();
  renderAgenda();
  renderCatch();
  if (ui.tab === "archive") renderArchive();
  paintColors();
  for (const t of typing) {
    const el = document.getElementById(t.id);
    if (!el) continue;
    el.value = t.value;
    if (t.focused) { el.focus(); el.setSelectionRange(t.pos, t.pos); }
  }
}

function renderHeader() {
  const s = ui.state;
  const now = new Date();
  $("#full-date").textContent = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz() });
  const next = s.agenda.find((e) => e.start.length > 10 && e.start.slice(0, 10) === s.today && e.start.slice(11, 16) >= hhmm(now));
  const short = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz() });
  $("#glance").innerHTML = next ? `${esc(short)} · Next <strong>${esc(next.start.slice(11, 16))}</strong> ${esc(next.title)}` : esc(short);
  const asked = s.bots.some((b) => b.refreshRequestedAt);
  const label = asked ? "Scan requested" : ago(s.lastScanAt);
  $("#refresh-label").textContent = label;
  $("#fresh").textContent = label;
  $("#refresh").classList.toggle("busy", asked);
  const hooks = s.bots.filter((b) => b.hasWebhook).length;
  $("#foot").textContent = s.bots.length
    ? `${s.bots.length} bot${s.bots.length > 1 ? "s" : ""} connected. ${hooks ? "Taps reach the bots within seconds." : "No bot has a webhook yet, so taps wait for the next scheduled scan."}`
    : "No bot has posted yet. Set up the Dashboard bot from bot/README.md in the repo.";
}

function renderFilters() {
  const needs = ui.state.needs.filter((i) => i.status !== "closed");
  const bots = ui.state.bots.filter((b) => ui.state.needs.some((i) => i.bot === b.slug) || ui.state.catchup.some((i) => i.bot === b.slug));
  if (ui.filter !== "all" && !bots.some((b) => b.slug === ui.filter)) ui.filter = "all";
  const chip = (slug, label, count, extra = "") =>
    `<button class="chip-filter${extra}" aria-pressed="${ui.filter === slug}" data-bot="${esc(slug)}">${label} <span class="count num">${count || ""}</span></button>`;
  $("#filters").innerHTML = bots.length < 2 ? "" :
    chip("all", "All", needs.length, " all") +
    bots.map((b) => chip(b.slug, `${avatar(b.slug)}${esc(b.name)}`, needs.filter((i) => i.bot === b.slug).length)).join("");
  $("#filters").hidden = bots.length < 2;
}

function cardActions(c) {
  const id = c.id;
  const write = `<button class="btn ghost" data-act="write" data-id="${id}">${icon("msg")}<span class="lbl">Write</span></button>`;
  const snooze = `<button class="btn ghost" data-act="snooze" data-id="${id}">${icon("clock")}<span class="lbl">Snooze</span></button>`;
  const dismiss = `<button class="btn ghost" data-act="dismiss" data-id="${id}" aria-label="Dismiss">${icon("x")}</button>`;
  if (ui.editing.has(id)) {
    return `<button class="btn primary" data-act="send-edited" data-id="${id}">${icon("send")}Send to ${esc(c.draft.to)}</button>
      <button class="btn" data-act="cancel-edit" data-id="${id}">Cancel</button>`;
  }
  if (c.kind === "choice") {
    return c.options.map((o, i) => `<button class="btn suggest${i === 0 ? " primary" : ""}" data-act="choose" data-id="${id}" data-option="${i}">${esc(o.label)}</button>`).join("") +
      `<span class="end">${write}${snooze}</span>`;
  }
  if (c.kind === "draft") {
    return `<button class="btn primary" data-act="send" data-id="${id}">${icon("send")}Send to ${esc(c.draft.to)}</button>
      <button class="btn" data-act="edit" data-id="${id}">${icon("pencil")}Edit</button>
      <span class="end">${write}${dismiss}</span>`;
  }
  return `<button class="btn primary" data-act="done" data-id="${id}">${icon("check")}Mark done</button>
    <span class="end">${write}${snooze}${dismiss}</span>`;
}

function renderCard(c) {
  const bot = botOf(c.bot).name;
  if (c.status === "closed") {
    return `<div class="resolved done" role="status"><span class="ok">${icon("check")}</span><span class="status"><strong>${esc(c.resolution || "Done")}</strong><br>${esc(c.title)}</span><button class="btn ghost" data-act="ack" data-id="${c.id}" aria-label="Hide">${icon("x")}</button></div>`;
  }
  const p = c.pendingAction;
  if (c.status === "pending" && p) {
    const what = p.type === "send" ? `Sending your reply to ${c.draft?.to ?? "them"}` : p.type === "write" ? `"${p.text}"` : p.label;
    if (p.status === "queued") {
      const left = Math.max(0, Math.ceil((p.runAfter - Date.now()) / 1000));
      return `<div class="resolved" role="status"><span class="pending-dot"></span><span class="status"><strong>${esc(what)}</strong><br>Sending to ${esc(bot)} in <span class="num" data-countdown="${p.runAfter}">${left}</span>s</span><button class="btn" data-act="undo" data-action="${p.id}">Undo</button></div>`;
    }
    return `<div class="resolved" role="status"><span class="pending-dot"></span><span class="status"><strong>${esc(what)}</strong><br>${esc(bot)} is on it</span></div>`;
  }
  const open = ui.open.has(c.id) || Boolean(c.urgent) || Boolean(c.error) || ui.editing.has(c.id) || ui.writing.has(c.id) || ui.snoozing.has(c.id);
  const draft = c.kind === "draft" && c.draft
    ? ui.editing.has(c.id)
      ? `<label class="sr-only" for="d-${c.id}">Edit the reply</label><textarea class="draft-edit" id="d-${c.id}">${esc(c.draft.text)}</textarea>`
      : `<div class="draft-label">Draft reply${c.draft.channel ? ` on ${esc(c.draft.channel)}` : ""}</div><div class="draft">${esc(c.draft.text)}</div>`
    : "";
  const write = ui.writing.has(c.id)
    ? `<form class="write" data-form="${c.id}"><label class="sr-only" for="w-${c.id}">Tell ${esc(bot)} what to do</label><input id="w-${c.id}" placeholder="Tell ${esc(bot)} what to do" autocomplete="off" maxlength="2000"><button class="btn primary" aria-label="Send">${icon("send")}</button></form>`
    : "";
  const snooze = ui.snoozing.has(c.id)
    ? `<div class="menu"><span class="label">Snooze until</span>${snoozeChoices().map((s) => `<button class="btn suggest" data-act="snooze-to" data-id="${c.id}" data-until="${s.until.getTime()}">${s.label}</button>`).join("")}</div>`
    : "";
  const source = c.link ? `<a class="src" href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.source || "Open")}</a>` : `<span class="src">${esc(c.source)}</span>`;
  return `<article class="card${c.urgent ? " urgent" : ""}${open ? " open" : ""}" aria-labelledby="t-${c.id}">
    <div class="meta">${avatar(c.bot)}${source}<time class="num">${when(c.createdAt)}</time></div>
    ${c.urgent ? `<div class="flag-row"><span class="flag">Urgent · ${esc(c.urgent)}</span></div>` : ""}
    <h3 id="t-${c.id}"><button class="title-btn" data-act="expand" data-id="${c.id}" aria-expanded="${open}">${esc(c.title)}${icon("chev", "i more")}</button></h3>
    <div class="detail">${c.body ? `<p>${esc(c.body)}</p>` : ""}${c.context ? `<p class="context">${esc(c.context)}</p>` : ""}</div>
    ${draft}
    ${c.error ? `<div class="error">Last try failed: ${esc(c.error)}</div>` : ""}
    <div class="actions">${cardActions(c)}</div>
    ${write}${snooze}
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
    const late = t.due.slice(0, 10) < today;
    parts.push({ text: (late ? "Overdue · " : "") + dayLabel(t.due.slice(0, 10), today) + time, late });
  }
  if (t.deadline) parts.push({ text: `Deadline ${dayLabel(t.deadline, today).toLowerCase()}`, late: t.deadline <= today });
  return parts;
}

function renderTodos() {
  const s = ui.state;
  const t = s.todos;
  const today = s.today;
  $("#todo-source").textContent = t.source === "todoist" ? "From Todoist" : t.source === "bot" ? "From your bots" : "";
  const now = Date.now();
  for (const [id, v] of ui.doneTodos) if (now - v.at > 15000) ui.doneTodos.delete(id);
  const items = t.items.filter((x) => !ui.doneTodos.has(x.id));
  $("#todo-count").textContent = items.length || "";
  if (t.source === "none") {
    $("#todos").innerHTML = `<div class="empty-row"><strong>No to-do list connected.</strong> Set <code>TODOIST_TOKEN</code> on the server, or let a bot send your to-dos.</div>`;
    return;
  }
  const row = (x, done) => `
    <div class="todo${done ? " is-done" : ""}">
      <button class="check p${x.priority}" data-act="todo" data-todo="${esc(x.id)}" aria-pressed="${done}" aria-label="${done ? "Undo" : "Complete"}: ${esc(x.content)}">${icon("check")}</button>
      <div class="body">
        <div class="t">${esc(x.content)}</div>
        <div class="sub">${done
          ? `<span>Completed</span><button class="btn ghost undo" data-act="todo-undo" data-todo="${esc(x.id)}">Undo</button>`
          : `<span class="prio p${x.priority}">P${x.priority}</span>${todoWhen(x, today).map((w) => `<span class="${w.late ? "late" : ""}">${esc(w.text)}</span>`).join("")}${x.project ? `<span>${esc(x.project)}</span>` : ""}`}</div>
      </div>
    </div>`;
  const done = [...ui.doneTodos.values()].map((v) => row(v.todo, true));
  const body = done.join("") + items.map((x) => row(x, false)).join("");
  const more = t.hidden ? `${t.hidden} more without a date this week` : "Sorted by date, then priority";
  const link = t.source === "todoist" ? `<a href="https://app.todoist.com/app/today" target="_blank" rel="noopener">Open Todoist</a>` : "";
  $("#todos").innerHTML =
    (t.error ? `<div class="empty-row"><strong>Todoist didn't answer.</strong> ${esc(t.error)}</div>` : "") +
    (body || `<div class="empty-row">Nothing due this week.</div>`) +
    `<div class="list-foot"><span>${esc(more)}</span>${link}</div>`;
}

function renderAgenda() {
  const s = ui.state;
  const tomorrow = new Date(Date.parse(s.today + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
  const now = hhmm(new Date());
  let nextMarked = false;
  const day = (label, date) => {
    const evs = s.agenda.filter((e) => e.start.slice(0, 10) === date);
    const rows = evs.map((e) => {
      const time = e.allDay ? "All day" : e.start.slice(11, 16);
      const end = e.end && e.end.length > 10 ? `${e.location ? "until" : "Until"} ${e.end.slice(11, 16)}` : "";
      const past = date === s.today && !e.allDay && (e.end ? e.end.slice(11, 16) : time) < now;
      const isNext = !nextMarked && date === s.today && !e.allDay && time >= now;
      if (isNext) nextMarked = true;
      const where = [e.location, end].filter(Boolean).join(", ");
      return `<div class="ev${past ? " past" : ""}${isNext ? " now" : ""}">
        <div class="when num">${esc(time)}</div>
        <div><div class="what">${esc(e.title)}${isNext ? ` <span class="now-label">Next</span>` : ""}</div>${where ? `<div class="where">${esc(where)}</div>` : ""}</div>
      </div>`;
    });
    return `<div class="day">${label}</div><div class="list">${rows.join("") || `<div class="empty-row">Nothing in the calendar.</div>`}</div>`;
  };
  $("#agenda").innerHTML = day("Today", s.today) + day("Tomorrow", tomorrow);
}

function renderCatch() {
  const list = ui.state.catchup.filter(visible);
  $("#catch-count").textContent = list.filter((c) => c.status !== "closed").length || "";
  const openIds = new Set($$("#catchup details[open]").map((d) => d.dataset.id));
  $("#catchup").innerHTML = list.length
    ? list.map((c) => {
        const read = c.status === "closed";
        const pending = c.status === "pending";
        return `<details class="catch${read ? " read" : ""}" data-id="${c.id}"${openIds.has(String(c.id)) ? " open" : ""}>
          <summary>${avatar(c.bot)}<span class="ttl">${esc(c.title)}</span><span class="n num">${esc(c.countLabel)}</span>${icon("chev", "i chev")}</summary>
          <p class="gist">${esc(c.body)}</p>
          ${ui.writing.has(c.id) ? `<form class="write catch-write" data-form="${c.id}"><label class="sr-only" for="w-${c.id}">Ask about this</label><input id="w-${c.id}" placeholder="Ask ${esc(botOf(c.bot).name)} about this" autocomplete="off" maxlength="2000"><button class="btn primary" aria-label="Send">${icon("send")}</button></form>` : ""}
          <div class="actions">${pending ? `<span class="context">${esc(botOf(c.bot).name)} is on it</span>` : `${read ? "" : `<button class="btn" data-act="read" data-id="${c.id}">${icon("check")}Mark as read</button>`}<button class="btn ghost" data-act="write" data-id="${c.id}">${icon("msg")}Ask about this</button>`}</div>
        </details>`;
      }).join("")
    : `<div class="empty-row">All caught up.</div>`;
}

let archiveSeq = 0;
async function renderArchive() {
  const seq = ++archiveSeq;
  const q = $("#arch-q").value.trim();
  let items;
  try {
    items = (await api("GET", `/api/ui/archive?q=${encodeURIComponent(q)}`)).items;
  } catch (err) {
    $("#archive").innerHTML = `<div class="empty-row"><strong>Couldn't load the archive.</strong> ${esc(err.message)}</div>`;
    return;
  }
  if (seq !== archiveSeq) return;
  items = items.filter(visible);
  $("#archive").innerHTML = items.length
    ? items.map((a) => {
        const why = a.status === "snoozed"
          ? `Snoozed until ${whenFull(a.snoozedUntil)}`
          : `${a.closedReason === "bot" ? `Closed by ${botOf(a.bot).name}: ` : ""}${a.resolution || a.closedReason} · ${when(a.closedAt)}`;
        const restore = a.closedReason === "action" ? "" : `<button class="btn" data-act="restore" data-id="${a.id}">Restore</button>`;
        return `<div class="arch">${avatar(a.bot)}<div class="body"><div class="t">${esc(a.title)}</div><div class="why">${esc(why)}</div></div>${restore}</div>`;
      }).join("")
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
  if (tab === "archive") renderArchive();
  window.scrollTo({ top: 0 });
}

const item = (id) => [...ui.state.needs, ...ui.state.catchup].find((x) => x.id === Number(id));
const actOn = (id, body) => run("POST", `/api/ui/items/${id}/act`, body);

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act], [data-tab], [data-bot]");
  if (!b || !ui.state) return;
  if (b.dataset.tab) return setTab(b.dataset.tab);
  if (b.dataset.bot) {
    ui.filter = b.dataset.bot;
    render();
    return;
  }
  const id = Number(b.dataset.id);
  const toggle = (set) => { set.has(id) ? set.delete(id) : set.add(id); };
  switch (b.dataset.act) {
    case "expand": toggle(ui.open); render(); break;
    case "choose": await actOn(id, { type: "choose", option: Number(b.dataset.option) }); break;
    case "send": await actOn(id, { type: "send" }); break;
    case "edit": ui.editing.add(id); render(); $(`#d-${id}`)?.focus(); break;
    case "cancel-edit": ui.editing.delete(id); render(); break;
    case "send-edited": {
      const text = $(`#d-${id}`).value.trim();
      if (!text) return $(`#d-${id}`).focus();
      ui.editing.delete(id);
      await actOn(id, { type: "send", text });
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
    case "snooze-to":
      ui.snoozing.delete(id);
      await actOn(id, { type: "snooze", until: Number(b.dataset.until) });
      toast(`Snoozed. It's in the archive until then.`);
      break;
    case "done": await actOn(id, { type: "done" }); break;
    case "dismiss": await actOn(id, { type: "dismiss" }); toast("Dismissed. Restore it from the archive."); break;
    case "read": e.preventDefault(); await actOn(id, { type: "read" }); break;
    case "restore": await actOn(id, { type: "restore" }); renderArchive(); break;
    case "undo": await run("POST", `/api/ui/actions/${b.dataset.action}/undo`, {}); break;
    case "ack": await run("POST", `/api/ui/items/${id}/ack`, {}); await load(); break;
    case "todo": {
      const t = ui.state.todos.items.find((x) => x.id === b.dataset.todo);
      if (!t) return;
      ui.doneTodos.set(t.id, { todo: t, at: Date.now() });
      renderTodos();
      const ok = await run("POST", `/api/ui/todos/${encodeURIComponent(t.id)}/complete`, {});
      if (!ok) { ui.doneTodos.delete(t.id); renderTodos(); }
      break;
    }
    case "todo-undo": {
      const id2 = b.dataset.todo;
      ui.doneTodos.delete(id2);
      await run("POST", `/api/ui/todos/${encodeURIComponent(id2)}/complete`, { undo: true });
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
  ui.writing.delete(id);
  await actOn(id, { type: "write", text });
});

$("#refresh").addEventListener("click", async () => {
  const data = await run("POST", "/api/ui/refresh", {});
  if (data) toast(data.webhooks ? "Asked the bots for a fresh scan." : "Scan requested. The bots pick it up on their next run.");
});

let searchTimer;
$("#arch-q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderArchive, 200);
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
    if (document.visibilityState === "visible" && !document.activeElement?.matches("input, textarea")) await load();
    schedule();
  }, busy ? 4000 : 20000);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });

load();
schedule();
