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
  settings: null,          // { groups, settings } from the server
  settingErrors: new Map(), // key -> { message, value } from a refused save, so what you typed stays
  needsAll: false,       // "Show N more" pressed in Needs you
  catchAll: false,       // "Show N more" pressed in Catch up
  catchOpen: new Set(),  // catch-up lines opened in this visit: they stay until closed, even once read
  awayOpen: false,       // the "While you were away" lines are unfolded
  seenSent: new Set(),   // "id:updatedAt" already reported as seen
  seenNow: [],           // items on screen after the last render
  todosAll: false,       // the to-dos beyond today's three are unfolded
  bots: null,            // the Bots page, loaded when opened
  stripOpen: false,      // the bot strip unfolded while every bot is fine
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
  // A bot that is a known app with its own icon, like PoliTO, shows that icon.
  const icon = Object.hasOwn(BRANDS, slug) ? BRANDS[slug].img : "";
  if (icon) return `<span class="avatar" title="${esc(b.name)}"><img src="${esc(icon)}" alt=""></span>`;
  return `<span class="avatar" data-color="${esc(b.color)}" title="${esc(b.name)} bot">${esc((b.name || "?").charAt(0).toUpperCase())}</span>`;
};
const visible = (item) => ui.filter === "all" || item.bot === ui.filter;

/** Brand tile for where a card comes from, with the posting bot as a small badge when there are several bots. */
function brandTile(b, extra = "") {
  const mark = b.img
    ? `<img src="${esc(b.img)}" alt="">`
    : b.path
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${b.path}"/></svg>`
      : `<span class="letter" aria-hidden="true">${esc(b.letter)}</span>`;
  return `<span class="logo" data-color="${esc(b.color)}" title="${esc(b.name)}">${mark}${extra}</span>`;
}

function logo(item) {
  const b = brandFor(item.app, item.source) || brandFor("", item.title);
  if (!b) return avatar(item.bot);
  const bot = botOf(item.bot);
  // A source that is its own bot, like PoliTO, needs no badge saying so.
  const badge = ui.state.bots.length > 1 && bot.name.toLowerCase() !== b.name.toLowerCase()
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
  ui.seenNow = [];
  const active = document.activeElement;
  const key = focusKey(active);
  const caret = active && "selectionStart" in active ? active.selectionStart : null;
  renderHeader();
  renderFilters();
  renderNeeds();
  renderNow();
  renderTodos();
  renderAgenda();
  renderCatch();
  renderStrip();
  renderPinned();
  renderSettingsBots();
  renderAway();
  paintColors();
  reportSeen();
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
  $("#arch-q").placeholder = `Search the last ${s.archiveDays} days`;
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
  const politoError = s.polito?.error ? `PoliTO avvisi couldn't be checked: ${s.polito.error}` : "";
  const problems = s.sourceProblems || [];
  $("#offline").hidden = !down.length && !politoError && !problems.length;
  $("#offline").textContent = down
    .map((b) => `${b.name} hasn't checked in since ${b.lastSeenAt ? whenFull(b.lastSeenAt) : "it was set up"}. ${b.hasWebhook ? "Tap Refresh to wake it." : "Taps wait for its next run."}`)
    .concat(politoError || [], problems)
    .join(" ");
  const asked = s.bots.some((b) => b.refreshRequestedAt);
  const label = asked ? "Scan requested" : allDown ? "Bot offline" : ago(s.lastScanAt);
  $("#refresh-label").textContent = label;
  $("#fresh").textContent = label;
  $("#refresh").classList.toggle("busy", asked);
  const hooks = s.bots.filter((b) => b.hasWebhook).length;
  // PoliTO has a filter chip like a bot, but no bot behind it.
  const real = s.bots.filter((b) => b.slug !== "polito").length;
  const runs = s.runs ? ` Bot runs this week: ${s.runs.week} of ${s.runs.cap}.` : "";
  $("#foot").textContent = (real
    ? `${real} bot${real > 1 ? "s" : ""} connected. ${hooks ? "Taps reach the bots within seconds." : "No bot has a webhook yet, so taps wait for the next scheduled scan."}`
    : "No bot has posted yet. Set up the Dashboard bot from bot/README.md in the repo.") + runs;
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
  // PoliTO cards come straight from PoliTO, with no bot to read a Write. Marking read reaches the phone app too.
  if (c.bot === "polito") return `<button class="btn primary" data-act="done" data-id="${id}">${icon("check")}Mark as read</button><span class="end">${snooze}${dismiss}</span>`;
  return `<button class="btn primary" data-act="done" data-id="${id}">${icon("check")}Mark done</button>${end}`;
}

/**
 * What an answer will make the bot do, shown when the instruction isn't just the button's words
 * with a little more detail. That's the case worth a second look before tapping, so it shows on collapsed cards too.
 */
function answersList(c) {
  // The dashboard's own calendar cards carry Grok's working instructions, not words for you: the card's context says it.
  if (c.kind !== "choice" || c.key?.includes(":event:")) return "";
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

/**
 * A card body as paragraphs, with runs of tab-separated lines as a table.
 * PoliTO avvisi carry their tables that way (one row per line, cells split by tabs).
 */
function richBody(text) {
  const out = [];
  let para = [];
  let rows = [];
  const flushPara = () => { if (para.length) out.push(`<p>${esc(para.join("\n").trim())}</p>`); para = []; };
  const flushRows = () => {
    if (rows.length >= 2) {
      const cells = rows.map((r) => r.split("\t"));
      // A first row with no numbers in it is a header, like "Matricola · Giorno · Ora".
      const head = cells[0].every((c) => !/\d/.test(c)) ? cells.shift() : null;
      const tr = (r, tag) => `<tr>${r.map((c) => `<${tag}>${esc(c)}</${tag}>`).join("")}</tr>`;
      out.push(`<div class="table-wrap" tabindex="0"><table>${head ? `<thead>${tr(head, "th")}</thead>` : ""}<tbody>${cells.map((r) => tr(r, "td")).join("")}</tbody></table></div>`);
    } else {
      para.push(...rows.map((r) => r.replace(/\t/g, " ")));
    }
    rows = [];
  };
  for (const line of text.split("\n")) {
    if (line.includes("\t")) { if (!rows.length) flushPara(); rows.push(line); continue; }
    if (rows.length) { flushRows(); flushPara(); }
    para.push(line);
  }
  flushRows();
  flushPara();
  return out.join("");
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
    <div class="detail">${c.body ? richBody(c.body) : ""}${c.context ? `<p class="context">${esc(c.context)}</p>` : ""}</div>
    ${answersList(c)}
    ${draft}
    ${c.error ? `<div class="error">${esc(c.error)}</div>` : ""}
    <div class="actions">${cardActions(c)}</div>
    ${ui.writing.has(c.id) ? writeForm(c, `Tell ${bot} what to do`) : ""}${snooze}
  </article>`;
}

const PHONE = window.matchMedia("(max-width: 999px)");

function renderNeeds() {
  const list = ui.state.needs.filter(visible);
  const open = list.filter((c) => c.status !== "closed").length;
  $("#needs-count").textContent = open || "";
  // Urgent cards and taps in progress always show. The rest fill up to a few, then wait behind a button.
  const limit = PHONE.matches ? 3 : 5;
  const fixed = (c) => Boolean(c.urgent) || c.status !== "open";
  let room = Math.max(0, limit - list.filter(fixed).length);
  const shown = ui.needsAll ? list : list.filter((c) => fixed(c) || room-- > 0);
  const hidden = list.length - shown.length;
  ui.seenNow.push(...shown);
  const toggle = hidden
    ? `<button class="btn more-btn" data-act="needs-more">Show ${hidden} more</button>`
    : ui.needsAll && list.length > limit ? `<button class="btn more-btn" data-act="needs-less">Show fewer</button>` : "";
  $("#needs").innerHTML = list.length
    ? shown.map(renderCard).join("") + toggle
    : `<div class="empty"><strong>Nothing needs you right now</strong>Questions from your bots show up here.</div>`;
}

// ---------- panels and bots ----------

/** A panel a bot or add-on sent: blocks drawn with the page's own pieces, never its own HTML. */
function renderPanel(p) {
  if (!p?.blocks?.length) return "";
  const pending = (ui.state?.panelActions || []).filter((a) => a.bot === p.owner);
  const body = p.blocks.map((b, bi) => {
    switch (b.type) {
      case "text": return `<p class="pn-text">${esc(b.text)}</p>`;
      case "stats": return `<div class="pn-stats">${b.items.map((x) => `<div><span class="num">${esc(x.value)}</span><span>${esc(x.label)}</span></div>`).join("")}</div>`;
      case "list": return `<ul class="pn-list">${b.items.map((x) => `<li><div class="pn-li"><span class="pn-t">${x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>` : esc(x.title)}</span>${x.badge ? `<span class="pn-badge">${esc(x.badge)}</span>` : ""}</div>${x.sub ? `<div class="pn-sub">${esc(x.sub)}</div>` : ""}</li>`).join("")}</ul>`;
      case "table": return `<div class="table-wrap" tabindex="0"><table><thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      case "buttons": return `<div class="actions">${b.items.map((x, i) => `<button class="btn suggest${i === 0 ? " primary" : ""}" data-act="panel-press" data-owner="${esc(p.owner)}" data-block="${bi}" data-index="${i}" data-label="${esc(x.label)}"${x.instruction ? ` title="${esc(x.instruction)}"` : ""}>${esc(x.label)}</button>`).join("")}</div>`;
      case "image": return `<img class="pn-img" src="${esc(b.src)}" alt="${esc(b.alt)}">`;
      default: return "";
    }
  }).join("");
  const waits = pending.map((a) => a.status === "claimed"
    ? `<div class="resolved" role="status"><span class="pending-dot"></span><span class="status"><strong>${esc(a.label)}</strong><span class="line">${esc(botOf(a.bot).name)} is on it</span></span></div>`
    : `<div class="resolved" role="status"><span class="pending-dot"></span><span class="status"><strong>${esc(a.label)}</strong><span class="line">Sending in <span class="num" data-countdown="${a.runAfter}">${Math.max(0, Math.ceil((a.runAfter - Date.now()) / 1000))}</span>s</span></span><button class="btn" data-act="undo" data-action="${a.id}">Undo</button></div>`).join("");
  return `<div class="panel">${body}${waits}</div>`;
}

const shownBots = () => (ui.state?.bots || []).filter((b) => b.kind === "bot" && b.shown);
const statusWord = { idle: "Idle", working: "Working", offline: "Offline" };

/** One line per shown bot under Now and next. While all is fine it folds to a single line. */
function renderStrip() {
  const bots = shownBots();
  const el = $("#bot-strip");
  el.hidden = !bots.length;
  if (!bots.length) return;
  const trouble = bots.filter((b) => b.status === "offline");
  const working = bots.filter((b) => b.status === "working");
  if (!ui.stripOpen && !trouble.length && !working.length) {
    el.innerHTML = `<button class="strip-fold" data-act="strip-open" aria-expanded="false">${bots.map((b) => avatar(b.slug)).join("")}<span>${bots.length} bot${bots.length === 1 ? "" : "s"}, all idle</span>${icon("chev", "i chev")}</button>`;
    return;
  }
  el.innerHTML = `<ul class="strip">${bots.map((b) => `<li><button class="strip-bot${b.status === "offline" ? " bad" : ""}" data-act="open-bot" data-slug="${esc(b.slug)}">${avatar(b.slug)}<span class="nm">${esc(b.name)}</span><span class="st">${statusWord[b.status]}${b.lastSeenAt ? ` · ${esc(when(b.lastSeenAt))}` : ""}</span></button></li>`).join("")}</ul>` +
    (!trouble.length && !working.length ? `<button class="btn ghost strip-less" data-act="strip-close">Fold</button>` : "");
}

function renderPinned() {
  const list = (ui.state.pinned || []).filter((p) => p.blocks.length);
  $("#pinned").innerHTML = list.map((p) => `<section class="s-panel" aria-label="${esc(p.name)}">
    <div class="sec-head"><h2>${esc(p.title || p.name)}</h2><span class="note">${esc(p.title ? p.name : "")}<button class="btn ghost pin-btn" data-act="panel-pin" data-owner="${esc(p.owner)}" data-pinned="false" aria-label="Unpin from Today" title="Unpin from Today">${icon("x")}</button></span></div>
    ${renderPanel(p)}
  </section>`).join("");
}

async function loadBots() {
  try {
    ui.bots = await api("GET", "/api/ui/bots");
    renderBots();
  } catch (err) {
    $("#bots").innerHTML = `<div class="empty-row">${esc(err.message)}</div>`;
  }
}

const kindWord = { choice: "Question", draft: "Draft", reminder: "Reminder", digest: "Summary" };
const handoffWord = { queued: "Waiting", sent: "Taken", done: "Done", failed: "Failed", cancelled: "Cancelled" };

function renderBots() {
  if (!ui.bots) return;
  const shown = ui.bots.bots.filter((b) => b.shown);
  const hidden = ui.bots.bots.length - shown.length;
  $("#bots").innerHTML = (shown.length ? shown.map((b) => {
    const facts = [statusWord[b.status], b.lastSeenAt ? `seen ${when(b.lastSeenAt)}` : "never seen", `${b.runsThisWeek} run${b.runsThisWeek === 1 ? "" : "s"} this week`, b.hasWebhook ? "" : "no webhook, so the dashboard can't wake it"].filter(Boolean);
    const pin = b.panel?.blocks?.length
      ? `<button class="btn ghost" data-act="panel-pin" data-owner="${esc(b.slug)}" data-pinned="${!b.panel.pinned}">${icon("pin")}${b.panel.pinned ? "Unpin from Today" : "Pin to Today"}</button>`
      : "";
    return `<section class="bot-page" id="bot-${esc(b.slug)}" aria-labelledby="bh-${esc(b.slug)}">
      <div class="bot-head">${avatar(b.slug)}<div><h2 id="bh-${esc(b.slug)}">${esc(b.name)}</h2>${b.role ? `<p class="role">${esc(b.role)}</p>` : ""}<p class="facts${b.status === "offline" ? " bad" : ""}">${esc(facts.join(" · "))}</p></div><span class="spacer"></span>${pin}</div>
      ${b.panel?.blocks?.length ? `${b.panel.title ? `<h3 class="pn-title">${esc(b.panel.title)}</h3>` : ""}${renderPanel(b.panel)}` : `<p class="empty-row">No panel yet. ${esc(b.name)} sends one when it runs.</p>`}
      ${b.handoffs.length ? `<h3 class="pn-title">Handoffs today</h3><ul class="pn-list">${b.handoffs.map((h) => `<li><div class="pn-li"><span class="pn-t">${h.from === b.slug ? `To ${esc(botOf(h.to).name)}` : `From ${esc(botOf(h.from).name)}`}: ${esc(h.text)}</span><span class="pn-badge">${esc(handoffWord[h.status])}</span></div>${h.result ? `<div class="pn-sub">${esc(h.result)}</div>` : ""}</li>`).join("")}</ul>` : ""}
      ${b.cards.length ? `<h3 class="pn-title">Its cards</h3><ul class="pn-list">${b.cards.map((c) => `<li><div class="pn-li"><span class="pn-t">${esc(c.title)}</span><span class="pn-badge">${esc(c.urgent || kindWord[c.kind] || c.kind)}</span></div></li>`).join("")}</ul>` : ""}
    </section>`;
  }).join("") : `<div class="empty"><strong>No bots on this page yet</strong>Pick the bots that belong here under Settings, Bots.</div>`) +
    (hidden ? `<p class="settings-note">${hidden} bot${hidden === 1 ? " works" : "s work"} behind the scenes. Their cards still reach Today.</p>` : "");
  paintColors();
  if (ui.scrollToBot) {
    $(`#bot-${CSS.escape(ui.scrollToBot)}`)?.scrollIntoView({ block: "start" });
    ui.scrollToBot = null;
  }
}

function renderSettingsBots() {
  const el = $("#settings-bots");
  if (!el || ui.tab !== "settings") return;
  const bots = ui.state.bots.filter((b) => b.kind === "bot");
  if (el.contains(document.activeElement)) return;
  el.innerHTML = bots.length ? bots.map((b) => `<div class="setting bot-row">
    <div class="s-text"><p class="s-label">${avatar(b.slug)} ${esc(b.name)}</p>
      <p class="help">${b.hasWebhook ? "Has a webhook: the dashboard can wake it." : "No webhook yet: it only sees taps when it runs on its own."}</p>
      <fieldset class="reads"><legend>May also read</legend>${[["agenda", "Agenda"], ["todos", "To-dos"], ["cards", "Every card"]].map(([k, l]) => `<label><input type="checkbox" data-act="bot-read" data-slug="${esc(b.slug)}" data-read="${k}"${b.reads.includes(k) ? " checked" : ""}> ${l}</label>`).join("")}</fieldset>
    </div>
    <div class="s-control"><label class="sw"><span>Shown</span><input type="checkbox" class="switch" data-act="bot-shown" data-slug="${esc(b.slug)}"${b.shown ? " checked" : ""} aria-label="Show ${esc(b.name)} on the Bots page"></label></div>
  </div>`).join("") : `<div class="empty-row">No bot has talked to the dashboard yet.</div>`;
}

// ---------- now and next ----------

/** Free time counts until this hour: after it, the day is over. */
const DAY_END = "22:00";

/**
 * Today's three to-dos: overdue P1 and P2 first, then what's due today, then other overdue ones.
 * Only things with a date today or earlier: the rest of the week can wait in the list.
 */
function pickForToday(items, today) {
  const stamp = nowStamp();
  const rank = (x) => {
    const late = x.due.length > 10 ? x.due < stamp : x.due.slice(0, 10) < today;
    return late && x.priority <= 2 ? 0 : late ? 2 : 1;
  };
  return items
    .filter((x) => x.due && x.due.slice(0, 10) <= today)
    .sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))
    .slice(0, 3);
}

/** Minutes left in today outside timed events, from now until DAY_END. */
function freeMinutes(events, today, stamp) {
  const at = (st) => (st.slice(0, 10) < today ? 0 : st.slice(0, 10) > today ? 1440 : Number(st.slice(11, 13)) * 60 + Number(st.slice(14, 16)));
  const from = at(stamp);
  const to = at(`${today}T${DAY_END}`);
  if (to <= from) return null;
  const busy = events
    .map((e) => [Math.max(from, at(e.start)), Math.min(to, at(e.end || e.start))])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let free = 0;
  let cur = from;
  for (const [a, b] of busy) {
    if (a > cur) free += a - cur;
    cur = Math.max(cur, b);
  }
  return free + Math.max(0, to - cur);
}

const duration = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60}` : ""}`);

function renderNow() {
  const s = ui.state;
  const stamp = nowStamp();
  const today = s.today;
  const tomorrow = `${addDay(today, 1)}T00:00:00`;
  const timed = s.agenda.filter((e) => !e.allDay && e.start.length > 10 && e.start < tomorrow && (e.end || e.start) > `${today}T00:00:00`);
  const current = timed.find((e) => e.start <= stamp && (e.end || e.start) > stamp);
  const next = timed.find((e) => e.start > stamp);
  const mins = (st) => Math.round((Date.parse(st + "Z") - Date.parse(stamp + "Z")) / 60000);
  const lines = [];
  if (current) lines.push(`<p><span class="nn-k">Now</span> <strong>${esc(current.title)}</strong>${current.end ? ` until ${esc(current.end.slice(11, 16))}` : ""}</p>`);
  if (next) lines.push(`<p><span class="nn-k">Next</span> <strong>${esc(next.start.slice(11, 16))} ${esc(next.title)}</strong> in ${esc(duration(mins(next.start)))}</p>`);
  if (!current && !next) lines.push(`<p><span class="nn-k">Next</span> Nothing else in the calendar today</p>`);
  const free = freeMinutes(timed, today, stamp);
  if (free !== null) lines.push(`<p><span class="nn-k">Free</span> ${free ? `${esc(duration(free))} before ${DAY_END}` : `Booked until ${DAY_END}`}</p>`);
  const t = s.todos;
  const picks = t.source === "none" ? [] : pickForToday(t.items.filter((x) => !ui.doneTodos.has(todoKey(x))), today);
  const todo = (x) => {
    const k = todoKey(x);
    const busy = ui.todoBusy.has(k) ? " disabled" : "";
    const when = todoWhen(x, today)[0];
    return `<li><button class="check p${x.priority}" data-act="todo" data-todo="${esc(k)}" aria-pressed="false" aria-label="Complete: ${esc(x.content)}"${busy}>${icon("check")}</button>
      <span class="nn-t">${esc(x.content)}${when ? ` <span class="nn-when${when.late ? " late" : ""}">${esc(when.text)}</span>` : ""}</span></li>`;
  };
  $("#now").innerHTML = `<div class="nn-day">${lines.join("")}</div>
    <div class="nn-todos"><p class="nn-k">For today</p>${picks.length ? `<ul>${picks.map(todo).join("")}</ul>` : `<p class="nn-none">Nothing due today.</p>`}</div>`;
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
  const all = t.items.filter((x) => !ui.doneTodos.has(todoKey(x)));
  $("#todo-count").textContent = all.length || "";
  // Today's three sit in the strip at the top; the rest fold away here.
  const picked = new Set(pickForToday(all, today).map(todoKey));
  const rest = all.filter((x) => !picked.has(todoKey(x)));
  const items = ui.todosAll ? rest : [];
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
  const later = t.hidden ? `, ${t.hidden} more without a date` : "";
  const more = !rest.length
    ? (t.hidden ? `${t.hidden} more without a date this week` : "")
    : `<button class="btn ghost" data-act="${ui.todosAll ? "todos-less" : "todos-more"}" aria-expanded="${ui.todosAll}">${ui.todosAll ? "Show fewer" : `${rest.length} more this week${later}`}</button>`;
  const link = t.source === "todoist" ? `<a href="https://app.todoist.com/app/today" target="_blank" rel="noopener noreferrer">Open Todoist</a>` : "";
  $("#todos").innerHTML =
    (t.error ? `<div class="empty-row"><strong>Todoist didn't answer.</strong> ${esc(t.error)}</div>` : "") +
    (body || (all.length ? "" : `<div class="empty-row">Nothing due this week.</div>`)) +
    `<div class="list-foot${body ? "" : " alone"}"><span>${rest.length ? more : esc(more)}</span>${link}</div>`;
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

const SKIPPED = "inbox:skipped:";
const CATCH_LINES = 8;
const unread = (c) => c.status !== "closed";

/** One line per chat or sender: a course's PoliTO notices, or a mail sender's receipts, read as one. */
function catchGroups() {
  const groups = new Map();
  for (const c of ui.state.catchup.filter(visible)) {
    const key = c.key?.startsWith(SKIPPED) ? SKIPPED : `${c.bot}|${c.source || c.title}`;
    if (!groups.has(key)) groups.set(key, { key, items: [] });
    groups.get(key).items.push(c);
  }
  // A read line leaves the page, unless you opened it in this visit.
  return [...groups.values()].filter((g) => g.items.some(unread) || ui.catchOpen.has(g.key));
}

function catchItem(c, multi) {
  const pending = c.status === "pending" && c.pendingAction;
  const ask = c.bot === "polito" ? "" : `<button class="btn ghost" data-act="write" data-id="${c.id}">${icon("msg")}Ask about this</button>`;
  const open = c.link ? `<a class="btn ghost" href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">Open</a>` : "";
  return `<div class="catch-item">
    ${multi ? `<p class="gist-title">${esc(c.title)}</p>` : ""}
    ${c.body ? `<p class="gist">${esc(c.body)}</p>` : ""}${c.context ? `<p class="gist ctx">${esc(c.context)}</p>` : ""}
    ${pending ? `<div class="catch-pending">${pendingRow(c)}</div>` : `
    ${ui.writing.has(c.id) ? writeForm(c, `Ask ${botOf(c.bot).name} about this`) : ""}
    ${ask || open ? `<div class="actions">${open}${ask}</div>` : ""}`}
  </div>`;
}

function catchLine(g) {
  const first = g.items[0];
  const fresh = g.items.filter(unread);
  const multi = g.items.length > 1;
  const isOpen = ui.catchOpen.has(g.key) || g.items.some((c) => ui.writing.has(c.id) || c.status === "pending");
  const title = g.key === SKIPPED ? first.title : multi ? first.source.replace(/^WhatsApp · /, "") : first.title;
  const count = multi ? `${fresh.length || g.items.length} ${fresh.length ? "new" : "read"}` : first.countLabel || when(first.updatedAt);
  return `<details class="catch${fresh.length ? "" : " read"}${g.key === SKIPPED ? " skipped" : ""}"${isOpen ? " open" : ""}>
    <summary data-act="toggle-catch" data-group="${esc(g.key)}">${logo(first)}<span class="ttl">${esc(title)}</span><span class="n num">${esc(count)}</span>${icon("chev", "i chev")}</summary>
    ${g.items.map((c) => catchItem(c, multi)).join("")}
  </details>`;
}

function renderCatch() {
  const s = ui.state;
  const all = catchGroups();
  const skipped = all.filter((g) => g.key === SKIPPED);
  let lines = all.filter((g) => g.key !== SKIPPED);
  // Back from Away: what came in meanwhile folds into one line instead of a pile.
  const away = s.away?.back ? s.away : null;
  const during = (g) => away && g.items.every((c) => c.createdAt >= away.from && c.createdAt <= away.until);
  const awayLines = away ? lines.filter(during) : [];
  if (away) lines = lines.filter((g) => !during(g));
  const shown = ui.catchAll ? lines : lines.slice(0, CATCH_LINES);
  const hidden = lines.length - shown.length;
  const unreadIds = (gs) => gs.flatMap((g) => g.items.filter((c) => c.status === "open").map((c) => c.id));
  ui.catchIds = { all: unreadIds([...lines, ...awayLines]), away: unreadIds(awayLines) };
  ui.seenNow.push(...[...shown, ...skipped, ...(ui.awayOpen ? awayLines : [])].flatMap((g) => g.items));
  $("#catch-count").textContent = lines.length + awayLines.length || "";
  $("#catch-note").innerHTML = ui.catchIds.all.length ? `<button class="btn ghost" data-act="read-all">${icon("check")}Mark all read</button>` : "";
  const awayBlock = awayLines.length
    ? `<div class="away-sum">
        <p><strong>While you were away</strong> (${esc(dayLabel(localDay(new Date(away.from)), s.today))} to ${esc(dayLabel(localDay(new Date(away.until - 1)), s.today))}): ${awayLines.length} line${awayLines.length === 1 ? "" : "s"}</p>
        <div class="actions"><button class="btn" data-act="away-show">${ui.awayOpen ? "Hide them" : "Show them"}</button><button class="btn ghost" data-act="away-done">${icon("check")}Mark all read</button></div>
      </div>${ui.awayOpen ? `<div class="list">${awayLines.map(catchLine).join("")}</div>` : ""}`
    : "";
  const more = hidden
    ? `<div class="list-foot"><button class="btn ghost" data-act="catch-more">Show ${hidden} more</button></div>`
    : ui.catchAll && lines.length > CATCH_LINES ? `<div class="list-foot"><button class="btn ghost" data-act="catch-less">Show fewer</button></div>` : "";
  $("#catchup").innerHTML = awayBlock +
    (shown.length || skipped.length || !awayBlock
      ? `<div class="list">${shown.map(catchLine).join("") || `<div class="empty-row">All caught up.</div>`}${more}${skipped.map(catchLine).join("")}</div>`
      : "");
}

/** Tell the server what you could see, so its expiry clock only counts time you had it on screen. */
function reportSeen() {
  if (document.visibilityState !== "visible" || ui.tab !== "today") return;
  const fresh = ui.seenNow.filter((c) => c.status === "open" && !c.seenAt && !ui.seenSent.has(`${c.id}:${c.updatedAt}`));
  if (!fresh.length) return;
  const keys = fresh.map((c) => `${c.id}:${c.updatedAt}`);
  keys.forEach((k) => ui.seenSent.add(k));
  api("POST", "/api/ui/seen", { ids: [...new Set(fresh.map((c) => c.id))] }).catch(() => keys.forEach((k) => ui.seenSent.delete(k)));
}

function renderAway() {
  const a = ui.state.away;
  const on = Boolean(a?.active);
  $("#settings-away").innerHTML = `<div class="setting is-bool">
    <div class="s-text"><p class="s-label">${on ? `Away through ${esc(dayLabel(localDay(new Date(a.until - 1)), ui.state.today))}` : "Away mode"}</p>
    <p class="help">Going away for a few days? Until you're back nothing on the page expires and your phone gets no pings. Afterwards, what came in folds into one line.</p></div>
    <div class="s-control">${on ? `<button class="btn" data-act="away-end">I'm back</button>` : `<button class="btn" data-act="away-open">Pick a return day</button>`}</div>
  </div>`;
  $("#away-btn").classList.toggle("on", on);
  $("#away-btn").setAttribute("aria-label", on ? "Away mode is on" : "Away mode");
  const bar = $("#away-bar");
  bar.hidden = !on;
  if (on) {
    // Away ends at midnight: the last day away is the one before.
    const last = localDay(new Date(a.until - 1));
    bar.innerHTML = `<span>Away through <strong>${esc(dayLabel(last, ui.state.today))}</strong>. Nothing expires and your phone stays quiet.</span><button class="btn" data-act="away-end">I'm back</button>`;
  }
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
            ${a.source ? `<p class="context">${esc(a.source)}</p>` : ""}${a.body ? richBody(a.body) : ""}${a.context ? `<p class="context">${esc(a.context)}</p>` : ""}${draft}
            <div class="actions">${restore}${link}</div>
          </div>
        </details>`;
      }).join("") + (ui.archive.more ? `<div class="list-foot"><button class="btn" data-act="more-archive">Show older</button></div>` : "")
    : `<div class="empty arch-empty"><strong>${q ? "No matches" : "Nothing archived yet"}</strong>${q ? "Try another word, or clear the bot filter." : `Cards you finish, dismiss or snooze land here for ${ui.state?.archiveDays ?? 30} days.`}</div>`;
  paintColors();
}

// ---------- interactions ----------

const TITLES = { today: "Today", bots: "Bots", archive: "Archive", settings: "Settings" };

function setTab(tab) {
  ui.tab = tab;
  for (const t of $$("[data-tab]")) t.setAttribute("aria-selected", String(t.dataset.tab === tab));
  for (const name of Object.keys(TITLES)) $(`#view-${name}`).hidden = tab !== name;
  $("#view-title").textContent = TITLES[tab];
  // Bot filters only mean something on Today and Archive.
  $("#filters").classList.toggle("off", tab === "settings" || tab === "bots");
  if (tab === "archive") loadArchive();
  if (tab === "bots") loadBots();
  if (tab === "settings") { renderSettingsBots(); paintColors(); }
  if (tab === "settings") loadSettings();
  window.scrollTo({ top: 0 });
}

// ---------- settings ----------

async function loadSettings() {
  try {
    ui.settings = await api("GET", "/api/ui/settings");
    renderSettings();
  } catch (err) {
    $("#settings").innerHTML = `<div class="empty-row"><strong>Couldn't load the settings.</strong> ${esc(err.message)}</div>`;
  }
}

function settingSource(s) {
  if (s.source === "page") return `<span>Saved here</span><button class="btn ghost reset" data-act="setting-reset" data-key="${esc(s.key)}">${s.type === "secret" ? "Remove" : "Reset"}</button>`;
  if (s.source === "env") return `<span>From .env</span>`;
  return "";
}

function settingControl(s) {
  const id = `set-${s.key}`;
  const invalid = ui.settingErrors.has(s.key) ? ` aria-invalid="true" aria-describedby="err-${esc(s.key)}"` : "";
  if (s.type === "choice") {
    return `<select id="${id}" data-setting="${esc(s.key)}"${invalid}>${s.options.map(([v, l]) => `<option value="${esc(v)}"${v === s.value ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  }
  if (s.type === "bool") {
    return `<input type="checkbox" class="switch" id="${id}" data-setting="${esc(s.key)}"${s.value ? " checked" : ""}${invalid}>`;
  }
  const typed = ui.settingErrors.get(s.key)?.value;
  const value = typed !== undefined && typeof typed !== "boolean" ? typed : s.value;
  if (s.type === "int") {
    return `<span class="with-unit"><input type="number" inputmode="numeric" id="${id}" data-setting="${esc(s.key)}" min="${s.min}" max="${s.max}" value="${esc(value)}"${invalid}>${s.unit ? `<span class="unit">${esc(s.unit)}</span>` : ""}</span>`;
  }
  if (s.type === "secret") {
    // The page never gets a secret back, only whether one is set.
    return `<input type="password" id="${id}" data-setting="${esc(s.key)}" autocomplete="off" placeholder="${s.set ? "Set. Type to replace it" : "Not set"}"${invalid}>`;
  }
  return `<input type="${s.type === "url" ? "url" : "text"}" id="${id}" data-setting="${esc(s.key)}" autocomplete="off" spellcheck="false" placeholder="${esc(s.placeholder || "")}" value="${esc(value)}"${invalid}>`;
}

function renderSettings() {
  const { groups, settings } = ui.settings;
  $("#settings").innerHTML = groups.map((g) => {
    const rows = settings.filter((s) => s.group === g).map((s) => {
      const err = ui.settingErrors.get(s.key)?.message;
      return `<div class="setting${s.type === "bool" ? " is-bool" : ""}">
        <div class="s-text">
          <label for="set-${esc(s.key)}">${esc(s.label)}</label>
          <p class="help">${esc(s.help)}</p>
          ${err ? `<p class="s-error" id="err-${esc(s.key)}">${esc(err)}</p>` : ""}
          <p class="s-src">${settingSource(s)}</p>
        </div>
        <div class="s-control">${settingControl(s)}</div>
      </div>`;
    }).join("");
    const gid = g.replace(/\W+/g, "-");
    return `<section class="s-group" aria-labelledby="g-${gid}"><div class="sec-head"><h2 id="g-${gid}">${esc(g)}</h2><span class="note s-status" data-status-group="${esc(g)}" role="status"></span></div><div class="qr-slot" data-qr-group="${esc(g)}"></div><div class="list">${rows}</div></section>`;
  }).join("");
  renderSourceStatus();
}

let qrStamp = 0;
/** Status lines and the QR code update in place, so a poll never wipes what you're typing. */
function renderSourceStatus() {
  const list = ui.settings?.status || [];
  for (const el of $$("[data-status-group]")) {
    const st = list.find((x) => x.group === el.dataset.statusGroup);
    el.textContent = st ? st.text : "";
    el.classList.toggle("bad", Boolean(st && !st.ok));
    el.classList.toggle("on", Boolean(st?.on && st.ok));
  }
  for (const el of $$("[data-qr-group]")) {
    const st = list.find((x) => x.group === el.dataset.qrGroup);
    if (st?.needsLink) {
      if (!el.querySelector("[data-act=wa-link]")) {
        el.innerHTML = `<div class="qr qr-expired"><p>WhatsApp shows a QR code for a few minutes. Get a new one when your phone is at hand.</p><button class="btn primary" data-act="wa-link" data-slot="${st.slot}">Show a new QR code</button></div>`;
      }
      continue;
    }
    if (!st?.needsQr) { el.innerHTML = ""; continue; }
    // WhatsApp replaces its code every 20 seconds or so; the image is fetched again with each status poll.
    const src = `/api/ui/whatsapp/${st.slot}/qr?t=${qrStamp}`;
    if (!el.querySelector("img")) {
      el.innerHTML = `<div class="qr"><img alt="QR code to link WhatsApp" width="220" height="220"><ol><li>Open WhatsApp on your phone${st.slot === 2 ? " (the business number)" : ""}.</li><li>Go to Settings, then Linked devices.</li><li>Tap Link a device and point the camera at this code.</li></ol></div>`;
    }
    const img = $("img", el);
    if (img.getAttribute("src") !== src) img.src = src;
  }
}

async function pollSettingsStatus() {
  if (ui.tab !== "settings" || document.visibilityState !== "visible") return;
  try {
    const fresh = await api("GET", "/api/ui/settings");
    ui.settings = { ...ui.settings, status: fresh.status };
    qrStamp = Date.now();
    renderSourceStatus();
  } catch {
    // The Today banner already says when the server is unreachable.
  }
}
setInterval(pollSettingsStatus, 5000);

async function saveSetting(key, value) {
  try {
    ui.settings = await api("PUT", "/api/ui/settings", { values: { [key]: value } });
    ui.settingErrors.delete(key);
    toast(value === null ? "Back to the default." : "Saved.");
  } catch (err) {
    // A refused secret isn't kept on the page.
    const s = ui.settings.settings.find((x) => x.key === key);
    ui.settingErrors.set(key, { message: err.message, value: s?.type === "secret" ? undefined : value });
  }
  const focused = document.activeElement?.dataset?.setting;
  renderSettings();
  if (focused) $(`#set-${CSS.escape(focused)}`)?.focus();
  // Undo window and archive length show on the other tabs too.
  load();
}

document.addEventListener("change", (e) => {
  const key = e.target.dataset?.setting;
  if (!key || !ui.settings) return;
  const s = ui.settings.settings.find((x) => x.key === key);
  if (!s) return;
  if (s.type === "bool") return saveSetting(key, e.target.checked);
  if (s.type === "secret") {
    const v = e.target.value.trim();
    if (!v) return;
    e.target.value = "";
    return saveSetting(key, v);
  }
  saveSetting(key, s.type === "int" ? e.target.value.trim() : e.target.value);
});

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
  if (b?.dataset.act === "setting-reset") return saveSetting(b.dataset.key, null);
  if (b?.dataset.act === "wa-link") {
    b.disabled = true;
    b.textContent = "Asking WhatsApp for a code…";
    try {
      const fresh = await api("POST", `/api/ui/whatsapp/${b.dataset.slot}/link`, {});
      ui.settings = { ...ui.settings, status: fresh.status };
      renderSourceStatus();
    } catch (err) {
      toast(err.message);
      b.disabled = false;
      b.textContent = "Show a new QR code";
    }
    return;
  }
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
    case "needs-more": ui.needsAll = true; render(); break;
    case "strip-open": ui.stripOpen = true; renderStrip(); break;
    case "strip-close": ui.stripOpen = false; renderStrip(); break;
    case "open-bot": ui.scrollToBot = b.dataset.slug; setTab("bots"); break;
    case "panel-press":
      await run("POST", `/api/ui/panels/${encodeURIComponent(b.dataset.owner)}/press`, { block: Number(b.dataset.block), index: Number(b.dataset.index), label: b.dataset.label });
      if (ui.tab === "bots") loadBots();
      break;
    case "panel-pin":
      await run("POST", `/api/ui/panels/${encodeURIComponent(b.dataset.owner)}/pin`, { pinned: b.dataset.pinned === "true" });
      if (ui.tab === "bots") loadBots();
      break;
    case "todos-more": ui.todosAll = true; renderTodos(); break;
    case "todos-less": ui.todosAll = false; renderTodos(); break;
    case "away-open": openAwayMenu(); break;
    case "needs-less": ui.needsAll = false; render(); break;
    case "catch-more": ui.catchAll = true; render(); break;
    case "catch-less": ui.catchAll = false; render(); break;
    case "toggle-catch": {
      // Opening a line is reading it. It stays on the page until you fold it again.
      e.preventDefault();
      const key = b.dataset.group;
      if (ui.catchOpen.delete(key)) return render();
      ui.catchOpen.add(key);
      render();
      const ids = catchGroups().find((g) => g.key === key)?.items.filter((c) => c.status === "open").map((c) => c.id) ?? [];
      if (ids.length) await run("POST", "/api/ui/read", { ids });
      break;
    }
    case "read-all": if (await run("POST", "/api/ui/read", { ids: ui.catchIds.all.slice(0, 200) })) toast("Catch up cleared. It's all in the archive."); break;
    case "away-show": ui.awayOpen = !ui.awayOpen; render(); break;
    case "away-done":
      if (ui.catchIds.away.length && !(await run("POST", "/api/ui/read", { ids: ui.catchIds.away }))) break;
      ui.awayOpen = false;
      await run("POST", "/api/ui/away/summarized", {});
      break;
    case "away-end": await run("DELETE", "/api/ui/away", {}); break;
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

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset?.act === "bot-shown") {
    await run("PUT", `/api/ui/bots/${encodeURIComponent(el.dataset.slug)}`, { shown: el.checked });
  } else if (el.dataset?.act === "bot-read") {
    const reads = $$(`[data-act=bot-read][data-slug="${CSS.escape(el.dataset.slug)}"]`).filter((x) => x.checked).map((x) => x.dataset.read);
    await run("PUT", `/api/ui/bots/${encodeURIComponent(el.dataset.slug)}`, { reads });
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
PHONE.addEventListener("change", render);

// Away mode: pick the day you're back. You're away until the end of that day.
const dayAfter = (n) => addDay(localDay(new Date()), n);
function closeAwayMenu() {
  $("#away-menu").hidden = true;
  $("#away-btn").setAttribute("aria-expanded", "false");
}
function openAwayMenu(toggle = false) {
  const menu = $("#away-menu");
  menu.hidden = toggle ? !menu.hidden : false;
  $("#away-btn").setAttribute("aria-expanded", String(!menu.hidden));
  if (menu.hidden) return;
  window.scrollTo({ top: 0 });
  const input = $("#away-until");
  input.min = dayAfter(0);
  input.max = dayAfter(60);
  if (!input.value) input.value = dayAfter(3);
  input.focus();
}
$("#away-btn").addEventListener("click", () => {
  if (ui.state?.away?.active) return $("#away-bar [data-act=away-end]")?.focus();
  openAwayMenu(true);
});
$("#away-menu").addEventListener("click", (e) => {
  const days = e.target.closest("[data-away-days]")?.dataset.awayDays;
  if (days) $("#away-until").value = dayAfter(Number(days));
});
$("#away-cancel").addEventListener("click", closeAwayMenu);
$("#away-menu").addEventListener("submit", async (e) => {
  e.preventDefault();
  const day = $("#away-until").value;
  if (!day) return $("#away-until").focus();
  if (await run("PUT", "/api/ui/away", { until: day })) closeAwayMenu();
});

load();
schedule();
