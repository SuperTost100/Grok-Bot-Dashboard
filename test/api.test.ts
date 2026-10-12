import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { Todoist, pickTodos } from "../server/todoist.ts";
import { loadConfig, type Config } from "../server/config.ts";
import { parseWhen, snoozeChoices, localStamp } from "../server/time.ts";
import { checkWebhookUrl, isPrivateAddress } from "../server/webhook.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OWNER = "owner@example.com";
const TOKEN = "test-token-123";

let clock = Date.parse("2026-10-12T11:00:00Z");
const config: Config = {
  host: "127.0.0.1",
  port: 0,
  dataDir: "",
  authMode: "tailscale",
  ownerLogin: OWNER,
  botToken: TOKEN,
  todoistToken: "",
  todoistFilter: "",
  undoSeconds: 5,
  archiveDays: 30,
  tz: "Europe/Rome",
  webhookAllowPrivate: false,
  backupDays: 0,
  publicDir: new URL("../public", import.meta.url).pathname.replace(/\/$/, ""),
};

async function startServer() {
  const store = new Store(":memory:", () => clock);
  const pings: string[] = [];
  const server = http.createServer(createApp({ config, store, log: () => {}, notify: (bot, why) => pings.push(`${bot}:${why}`) }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { store, server, base: `http://127.0.0.1:${port}`, port, pings };
}

let s: Awaited<ReturnType<typeof startServer>>;
before(async () => { s = await startServer(); });
after(() => { s.server.close(); s.store.close(); });

type Who = "owner" | "stranger" | "nobody" | { bot: string };

async function call(method: string, path: string, body?: unknown, who: Who = "owner") {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (typeof who === "object") {
    headers.Authorization = `Bearer ${TOKEN}`;
    headers["X-Bot"] = who.bot;
  }
  if (who === "owner") headers["Tailscale-User-Login"] = OWNER;
  if (who === "stranger") headers["Tailscale-User-Login"] = "someone@else.com";
  const res = await fetch(s.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
}

const bot = (method: string, path: string, body?: unknown, name = "dashboard") => call(method, path, body, { bot: name });
const state = async () => (await call("GET", "/api/ui/state")).body;
const card = async (id: number) => (await state()).needs.find((i: { id: number }) => i.id === id);
// Like the page: answers carry the revision of the card on screen.
const act = (id: number, body: Record<string, unknown>) =>
  call("POST", `/api/ui/items/${id}/act`, ["choose", "send", "write"].includes(String(body.type)) && body.rev === undefined ? { ...body, rev: s.store.getItem(id)?.rev } : body);

// ---------- Auth and transport ----------

test("only the owner's Tailscale login opens the page and the UI API", async () => {
  assert.equal((await call("GET", "/", undefined, "nobody")).status, 403);
  assert.equal((await call("GET", "/api/ui/state", undefined, "stranger")).status, 403);
  const ok = await call("GET", "/");
  assert.equal(ok.status, 200);
  assert.match(String(ok.body), /<title>/);
});

test("the bot API needs the token, and the token doesn't open the UI", async () => {
  assert.equal((await call("GET", "/api/bot/items", undefined, "owner")).status, 401);
  const res = await fetch(s.base + "/api/ui/state", { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 403);
  assert.equal((await bot("GET", "/api/bot/items")).status, 200);
});

test("writes must be JSON, which blocks cross-site form posts", async () => {
  const res = await fetch(s.base + "/api/ui/refresh", {
    method: "POST",
    headers: { "Tailscale-User-Login": OWNER, "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(res.status, 415);
});

test("static files can't escape the public folder", async () => {
  assert.equal((await call("GET", "/..%2Fpackage.json")).status, 404);
  assert.equal((await call("GET", "/%2e%2e/server/app.ts")).status, 404);
  assert.equal((await call("GET", "/%E0%A4%A")).status, 404);
});

test("a malformed request path gets a 400 and the server keeps running", async () => {
  const raw = await new Promise<string>((resolve) => {
    const sock = net.connect(s.port, "127.0.0.1", () => sock.write("GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    let out = "";
    sock.on("data", (d) => (out += d));
    sock.on("end", () => resolve(out));
  });
  assert.match(raw, /^HTTP\/1.1 400/);
  assert.equal((await call("GET", "/healthz")).status, 200);
});

test("an oversized body gets a real 413", async () => {
  const res = await fetch(s.base + "/api/bot/items", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "X-Bot": "dashboard", "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x".repeat(600 * 1024) }),
  });
  assert.equal(res.status, 413);
});

// ---------- Cards and actions ----------

test("a choice goes from card to bot and back, with an undo window and a frozen snapshot", async () => {
  const posted = await bot("POST", "/api/bot/items", {
    key: "wa:lab-poll",
    kind: "choice",
    app: "whatsapp",
    title: "Marco needs your vote on the lab swap",
    body: "It's 4 to 4.",
    source: "WhatsApp · Lab group",
    urgent: "answer by 14:00",
    options: [
      { label: "Vote Tuesday", instruction: "Vote Tuesday in the Lab group poll" },
      { label: "Vote Monday", instruction: "Vote Monday in the Lab group poll" },
    ],
  });
  assert.equal(posted.status, 200);
  const id = posted.body.id;
  const first = await card(id);
  assert.equal(first.app, "whatsapp");

  // Tap, then undo inside the window: nothing reaches the bot.
  const tap = await act(id, { type: "choose", option: 0, rev: first.rev, label: "Vote Tuesday" });
  assert.equal(tap.body.action.status, "queued");
  assert.equal((await call("POST", `/api/ui/actions/${tap.body.action.id}/undo`, {})).status, 200);
  assert.equal((await bot("GET", "/api/bot/actions")).body.actions.length, 0);

  // Tap again and let the window pass. The bot gets the card as it was when tapped.
  const second = await act(id, { type: "choose", option: 1, rev: first.rev, label: "Vote Monday" });
  assert.equal((await act(id, { type: "choose", option: 0, rev: first.rev })).status, 409, "no double actions");
  clock += 6000;
  const res = (await bot("GET", "/api/bot/actions")).body;
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0].instruction, "Vote Monday in the Lab group poll");
  assert.equal(res.actions[0].card.title, "Marco needs your vote on the lab swap");
  assert.equal(res.actions[0].card.body, "It's 4 to 4.");
  assert.equal(res.timeZone, "Europe/Rome");
  assert.equal((await call("POST", `/api/ui/actions/${second.body.action.id}/undo`, {})).status, 409, "too late to undo");
  assert.equal((await bot("GET", "/api/bot/actions")).body.actions.length, 0, "not handed out twice");

  await bot("POST", `/api/bot/actions/${res.actions[0].id}`, { ok: true, result: "Voted Monday" });
  const done = await card(id);
  assert.equal(done.status, "closed");
  assert.equal(done.resolution, "Voted Monday");

  // Once acknowledged it leaves Today but stays in the archive.
  await call("POST", `/api/ui/items/${id}/ack`, {});
  assert.equal(await card(id), undefined);
  const archive = (await call("GET", "/api/ui/archive?q=lab%20swap")).body.items;
  assert.equal(archive[0].id, id);
});

test("a tap on an old version of a card is refused", async () => {
  const { body } = await bot("POST", "/api/bot/items", { key: "rev-test", kind: "choice", title: "Approve?", options: [{ label: "Decline" }, { label: "Approve" }] });
  const before = await card(body.id);
  await bot("POST", "/api/bot/items", { key: "rev-test", kind: "choice", title: "Approve?", options: [{ label: "Approve" }, { label: "Decline" }] });
  const stale = await act(body.id, { type: "choose", option: 0, rev: before.rev, label: "Decline" });
  assert.equal(stale.status, 409);
  const same = await bot("POST", "/api/bot/items", { key: "rev-test", kind: "choice", title: "Approve?", options: [{ label: "Approve" }, { label: "Decline" }] });
  assert.equal(same.body.created, false);
  assert.equal((await card(body.id)).rev, before.rev + 1, "an identical repost doesn't bump the revision");
  await act(body.id, { type: "dismiss" });
});

test("a claimed action that never reports back is not sent again", async () => {
  const { body } = await bot("POST", "/api/bot/items", { kind: "reminder", title: "Stale check" });
  await act(body.id, { type: "write", text: "reply to Ann" });
  clock += 6000;
  const [a] = (await bot("GET", "/api/bot/actions")).body.actions;
  clock += 21 * 60_000;
  assert.equal((await bot("GET", "/api/bot/actions")).body.actions.length, 0);
  const c = await card(body.id);
  assert.equal(c.status, "open");
  assert.match(c.error, /never confirmed/);
  // A late report still lands.
  assert.equal((await bot("POST", `/api/bot/actions/${a.id}`, { ok: true, result: "Replied" })).status, 200);
  assert.equal((await card(body.id)).status, "closed");
  await call("POST", `/api/ui/items/${body.id}/ack`, {});
});

test("only the bot holding an action can report it, and only once", async () => {
  const { body } = await bot("POST", "/api/bot/items", { kind: "reminder", title: "Report rules" });
  const tap = await act(body.id, { type: "write", text: "do it" });
  assert.equal((await bot("POST", `/api/bot/actions/${tap.body.action.id}`, { ok: true })).status, 409, "not claimed yet");
  clock += 6000;
  const [a] = (await bot("GET", "/api/bot/actions")).body.actions;
  assert.equal((await bot("POST", `/api/bot/actions/${a.id}`, { ok: true }, "venduto")).status, 404, "another bot");
  assert.equal((await bot("POST", `/api/bot/actions/${a.id}`, { ok: false, result: "WhatsApp is disconnected" })).status, 200);
  assert.equal((await card(body.id)).error, "WhatsApp is disconnected");
  assert.equal((await bot("POST", `/api/bot/actions/${a.id}`, { ok: true })).body.status, "failed", "a second report changes nothing");
  assert.equal((await card(body.id)).status, "open");
  await act(body.id, { type: "dismiss" });
});

test("snooze and dismiss cancel a tap still waiting, but not one the bot already took", async () => {
  const { body } = await bot("POST", "/api/bot/items", { kind: "reminder", title: "Snooze rules" });
  await act(body.id, { type: "write", text: "first" });
  assert.equal((await act(body.id, { type: "snooze", until: clock + 3600_000 })).status, 200);
  clock += 6000;
  assert.equal((await bot("GET", "/api/bot/actions")).body.actions.length, 0, "the snoozed tap was cancelled");
  await act(body.id, { type: "restore" });
  await act(body.id, { type: "write", text: "second" });
  clock += 6000;
  const [a] = (await bot("GET", "/api/bot/actions")).body.actions;
  assert.equal((await act(body.id, { type: "snooze", until: clock + 3600_000 })).status, 409);
  assert.equal((await act(body.id, { type: "dismiss" })).status, 409);
  await bot("POST", `/api/bot/actions/${a.id}`, { ok: true });
  await call("POST", `/api/ui/items/${body.id}/ack`, {});
});

test("a draft sends the edited text and the recipient the user saw", async () => {
  const { body } = await bot("POST", "/api/bot/items", { key: "draft-1", kind: "draft", title: "Reply to Alice", draft: { to: "Alice", channel: "WhatsApp", text: "Hi" } });
  await act(body.id, { type: "send", text: "Hi Alice!" });
  await bot("POST", "/api/bot/items", { key: "draft-1", kind: "draft", title: "Reply to Bob", draft: { to: "Bob", channel: "WhatsApp", text: "Hi" } });
  clock += 6000;
  const [a] = (await bot("GET", "/api/bot/actions")).body.actions;
  assert.equal(a.text, "Hi Alice!");
  assert.equal(a.card.draft.to, "Alice");
  await bot("POST", `/api/bot/actions/${a.id}`, { ok: true });
});

test("polling one bot doesn't steal another bot's webhook ping", async () => {
  const { body } = await bot("POST", "/api/bot/items", { kind: "reminder", title: "Venduto's card" }, "venduto");
  await act(body.id, { type: "write", text: "go" });
  clock += 6000;
  await bot("GET", "/api/bot/actions");
  assert.deepEqual(s.store.promoteDue(), ["venduto"]);
  const [a] = (await bot("GET", "/api/bot/actions", undefined, "venduto")).body.actions;
  await bot("POST", `/api/bot/actions/${a.id}`, { ok: true }, "venduto");
});

test("posting the same key updates the card, and dismissed cards stay dismissed, even after the archive expires", async () => {
  const one = await bot("POST", "/api/bot/items", { key: "sonos", kind: "reminder", title: "v1" }, "venduto");
  const two = await bot("POST", "/api/bot/items", { key: "sonos", kind: "reminder", title: "v2" }, "venduto");
  assert.equal(two.body.id, one.body.id);
  await act(one.body.id, { type: "dismiss" });
  assert.equal((await bot("POST", "/api/bot/items", { key: "sonos", kind: "reminder", title: "v3" }, "venduto")).body.ignored, true);
  clock += 31 * 86_400_000;
  s.store.purge(30);
  assert.equal((await bot("POST", "/api/bot/items", { key: "sonos", kind: "reminder", title: "v4" }, "venduto")).body.ignored, true);
  assert.equal((await bot("POST", "/api/bot/items", { key: "sonos", kind: "reminder", title: "v5", reopen: true }, "venduto")).body.reopened, true);
  await act(one.body.id, { type: "dismiss" });
});

test("catch-up summaries: reopen when they change, and take questions after being read", async () => {
  const one = await bot("POST", "/api/bot/items", { key: "wa:family", section: "catchup", title: "Family", body: "Dad sent links", countLabel: "3 messages" });
  await act(one.body.id, { type: "read" });
  assert.equal((await bot("POST", "/api/bot/items", { key: "wa:family", section: "catchup", title: "Family", body: "Dad sent links", countLabel: "3 messages" })).body.ignored, true);
  assert.equal((await act(one.body.id, { type: "write", text: "What links?" })).status, 200);
  clock += 6000;
  const [a] = (await bot("GET", "/api/bot/actions")).body.actions;
  await bot("POST", `/api/bot/actions/${a.id}`, { ok: true });
  const changed = await bot("POST", "/api/bot/items", { key: "wa:family", section: "catchup", title: "Family", body: "Mum called", countLabel: "5 messages" });
  assert.equal(changed.body.reopened, true);
});

test("the bot can close its own cards by key", async () => {
  await bot("POST", "/api/bot/items", { key: "poll:old", kind: "reminder", title: "Old poll" });
  assert.equal((await bot("POST", "/api/bot/items/close", { key: "poll:old", reason: "Poll closed" })).body.status, "closed");
  assert.equal((await call("GET", "/api/ui/archive?q=Old")).body.items[0].resolution, "Poll closed");
});

test("bad input gets a clear 400, never a 500", async () => {
  const cases: unknown[] = [
    { kind: "choice", title: "No options" },
    { title: "x", link: "javascript:alert(1)" },
    { section: "nope", title: "x" },
    { section: "catchup", kind: "choice", title: "x", options: ["a"] },
    { kind: "reminder", title: "x", options: ["a"] },
    { items: [null] },
    { items: [{ key: "a", title: "1" }, { key: "a", title: "2" }] },
  ];
  for (const c of cases) assert.equal((await bot("POST", "/api/bot/items", c)).status, 400, JSON.stringify(c));
  assert.equal((await call("POST", "/api/bot/items", { title: "x" }, { bot: "Not A Slug!" })).status, 400);
  assert.equal((await bot("PUT", "/api/bot/agenda", { events: [null] })).status, 400);
  assert.equal((await bot("PUT", "/api/bot/agenda", { events: [{ title: "x", start: "2026-10-12T99:99" }] })).status, 400);
  assert.equal((await bot("PUT", "/api/bot/agenda", { events: [{ title: "x", start: "2026-02-30" }] })).status, 400);
  assert.equal((await bot("PUT", "/api/bot/todos", { todos: [null] })).status, 400);
  assert.equal((await bot("PUT", "/api/bot/todos", { todos: [{ id: "1", content: "a" }, { id: "1", content: "b" }] })).status, 400);
});

test("snoozed cards disappear and come back on time", async () => {
  const { body } = await bot("POST", "/api/bot/items", { kind: "reminder", title: "Snooze me" });
  await act(body.id, { type: "snooze", until: clock + 3600_000 });
  assert.equal(await card(body.id), undefined);
  clock += 3601_000;
  assert.equal((await card(body.id)).status, "open");
  await act(body.id, { type: "dismiss" });
});

test("webhooks: public https only, and a new URL drops the old key", async () => {
  for (const u of ["http://example.com/h", "https://127.0.0.1/h", "https://localhost/h", "https://10.0.0.5/h", "https://100.82.235.102/h", "https://devbox.tail.ts.net/h", "https://[::1]/h"]) {
    assert.equal((await bot("POST", "/api/bot/register", { webhookUrl: u })).status, 400, u);
  }
  const reg = await bot("POST", "/api/bot/register", { name: "Dashboard", webhookUrl: "https://example.com/hook", webhookToken: "secret-key" });
  assert.equal(reg.body.bot.webhookToken, "set", "stored but never echoed");
  await bot("POST", "/api/bot/register", { webhookUrl: "https://example.org/other" });
  assert.equal(s.store.getBot("dashboard")!.webhookToken, "");
  await bot("POST", "/api/bot/register", { webhookUrl: "https://example.com/hook", webhookToken: "secret-key" });
  s.pings.length = 0;
  await call("POST", "/api/ui/refresh", {});
  assert.deepEqual(s.pings, ["dashboard:refresh"]);
  assert.equal((await bot("GET", "/api/bot/actions")).body.refreshRequested, true);
  await bot("POST", "/api/bot/scan", {});
  const after = (await bot("GET", "/api/bot/actions")).body;
  assert.equal(after.refreshRequested, false);
  assert.match(after.lastScanAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(isPrivateAddress("::ffff:127.0.0.1"));
  assert.equal(checkWebhookUrl("https://api2.cursor.sh/automations/webhook/x", false), "");
});

// ---------- Agenda ----------

test("agenda: local times, window checks and events spanning several days", async () => {
  const day = localStamp(new Date(clock), "Europe/Rome").slice(0, 10);
  const next = new Date(Date.parse(day + "T12:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  const r = await bot("PUT", "/api/bot/agenda", {
    from: day,
    app: "googlecalendar",
    events: [
      { title: "Gym", start: `${day}T15:00:00Z`, end: `${day}T16:00:00Z` },
      { title: "Tech talk", start: `${next}T14:30`, location: "Room 10C" },
      { title: "Holiday", start: next },
      { title: "Trip", start: `${day}T08:00:00+02:00`, end: `${next}T23:00:00+02:00` },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let agenda = (await state()).agenda;
  const gym = localStamp(new Date(`${day}T15:00:00Z`), "Europe/Rome");
  assert.ok(agenda.some((e: { start: string }) => e.start === gym), "UTC converted to Rome time");
  assert.equal(agenda.find((e: { title: string }) => e.title === "Holiday").allDay, true);
  assert.equal(agenda[0].app, "googlecalendar");
  const out = await bot("PUT", "/api/bot/agenda", { from: day, events: [{ title: "Far", start: "2027-01-01T10:00" }] });
  assert.equal(out.status, 400);
  // A trip that started two days ago and ends tomorrow still shows today.
  clock += 2 * 86_400_000;
  const later = localStamp(new Date(clock), "Europe/Rome").slice(0, 10);
  await bot("PUT", "/api/bot/agenda", {
    from: later,
    events: [{ title: "Long trip", start: `${day}T08:00`, end: new Date(Date.parse(later + "T12:00:00Z") + 86_400_000).toISOString().slice(0, 10) + "T20:00" }],
  });
  agenda = (await state()).agenda;
  assert.ok(agenda.some((e: { title: string }) => e.title === "Long trip"));
  const again = await bot("PUT", "/api/bot/agenda", { from: later, events: [{ title: "Long trip", start: `${day}T08:00`, end: `${later}T20:00` }] });
  assert.equal(again.status, 200);
  assert.equal((await state()).agenda.filter((e: { title: string }) => e.title === "Long trip").length, 1, "replaced, not duplicated");
});

// ---------- To-dos ----------

test("bot to-dos: per-bot ids, one completion at a time, undo only in time", async () => {
  await bot("PUT", "/api/bot/todos", { app: "todoist", todos: [{ id: "t1", content: "Reply to CFR", priority: "p2", due: localStamp(new Date(clock), "Europe/Rome").slice(0, 10) }, { id: "t2", content: "Someday", priority: "p4" }] });
  await bot("PUT", "/api/bot/todos", { todos: [{ id: "t1", content: "Venduto's t1", priority: "p1" }] }, "venduto");
  let todos = (await state()).todos;
  assert.equal(todos.source, "bot");
  assert.deepEqual(todos.items.map((t: { bot: string; id: string }) => `${t.bot}:${t.id}`).sort(), ["dashboard:t1", "venduto:t1"]);

  const done = await call("POST", "/api/ui/todos/complete", { bot: "venduto", id: "t1" });
  assert.equal(done.status, 200);
  assert.equal((await call("POST", "/api/ui/todos/complete", { bot: "venduto", id: "t1" })).status, 409, "no double completion");
  assert.equal((await call("POST", "/api/ui/todos/complete", { bot: "venduto", id: "t1", undo: true })).status, 200);
  todos = (await state()).todos;
  assert.equal(todos.items.length, 2, "dashboard's t1 was never touched");

  await call("POST", "/api/ui/todos/complete", { bot: "dashboard", id: "t1" });
  clock += 6000;
  const [a] = (await bot("GET", "/api/bot/actions")).body.actions;
  assert.equal(a.type, "complete_todo");
  assert.equal((await call("POST", "/api/ui/todos/complete", { bot: "dashboard", id: "t1", undo: true })).status, 409, "too late");
  await bot("POST", `/api/bot/actions/${a.id}`, { ok: true });
});

test("a recurring bot to-do comes back with its next date", async () => {
  await bot("PUT", "/api/bot/todos", { todos: [{ id: "r1", content: "Water plants", due: "2026-10-12" }] }, "plants");
  await call("POST", "/api/ui/todos/complete", { bot: "plants", id: "r1" });
  await bot("PUT", "/api/bot/todos", { todos: [{ id: "r1", content: "Water plants", due: "2026-10-12" }] }, "plants");
  assert.ok(s.store.findTodo("plants", "r1")!.completedAt, "same occurrence stays done");
  await bot("PUT", "/api/bot/todos", { todos: [{ id: "r1", content: "Water plants", due: "2026-10-13" }] }, "plants");
  assert.equal(s.store.findTodo("plants", "r1")!.completedAt, null, "next occurrence is open");
});

test("Todoist tasks: p1 the right way round, nearest date first, UTC times in local time", async () => {
  const calls: string[] = [];
  const fake = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(`${init?.method} ${u.pathname}`);
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/projects")) return json({ results: [{ id: "p", name: "Work" }], next_cursor: null });
    if (u.pathname.endsWith("/tasks")) {
      return json({
        results: [
          { id: "a", content: "Later", priority: 1, project_id: "p", due: { date: "2026-10-16" }, deadline: null },
          { id: "b", content: "Urgent", priority: 4, project_id: "p", due: null, deadline: { date: "2026-10-13" } },
          { id: "c", content: "Far away", priority: 1, project_id: "p", due: { date: "2026-12-01" }, deadline: null },
          { id: "d", content: "Late night", priority: 1, project_id: "p", due: { date: "2026-10-12", datetime: "2026-10-12T22:30:00Z" }, deadline: null },
        ],
        next_cursor: null,
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const t = new Todoist("tok", "", "Europe/Rome", fake);
  const all = await t.list();
  assert.equal(all.find((x) => x.id === "b")!.priority, 1);
  assert.equal(all.find((x) => x.id === "d")!.due, "2026-10-13T00:30:00");
  const { todos, hidden } = pickTodos(all, "2026-10-12");
  assert.deepEqual(todos.map((x) => x.id), ["b", "d", "a"]);
  assert.equal(hidden, 1);
  await t.close("b");
  assert.ok(calls.includes("POST /api/v1/tasks/b/close"));
});

// ---------- Helpers and config ----------

test("dates: real calendar dates only, offsets converted", () => {
  assert.equal(parseWhen("2026-10-12", "Europe/Rome"), "2026-10-12");
  assert.equal(parseWhen("2026-10-12T14:30", "Europe/Rome"), "2026-10-12T14:30:00");
  assert.equal(parseWhen("2026-10-12T12:30:00Z", "Europe/Rome"), "2026-10-12T14:30:00");
  assert.equal(parseWhen("2026-10-12T14:30:00+0200", "Europe/Rome"), "2026-10-12T14:30:00");
  assert.equal(parseWhen("2026-02-30", "Europe/Rome"), null);
  assert.equal(parseWhen("2026-10-12T24:00", "Europe/Rome"), null);
  assert.equal(parseWhen("tomorrow", "Europe/Rome"), null);
});

test("snooze presets follow the dashboard's time zone", () => {
  const now = Date.parse("2026-10-12T10:00:00Z"); // Monday 12:00 in Rome
  const choices = snoozeChoices(now, "Europe/Rome");
  const tomorrow = choices.find((c) => c.label === "Tomorrow 9:00")!;
  assert.equal(localStamp(new Date(tomorrow.until), "Europe/Rome"), "2026-10-13T09:00:00");
  assert.ok(choices.some((c) => c.label === "Tonight 19:00"));
  assert.equal(localStamp(new Date(choices.find((c) => c.label === "Monday 9:00")!.until), "Europe/Rome"), "2026-10-19T09:00:00");
});

test("config refuses nonsense numbers and time zones", () => {
  const base = { OWNER_LOGIN: OWNER, BOT_TOKEN: TOKEN };
  assert.throws(() => loadConfig({ ...base, UNDO_SECONDS: "-1" }), /UNDO_SECONDS/);
  assert.throws(() => loadConfig({ ...base, UNDO_SECONDS: "abc" }), /UNDO_SECONDS/);
  assert.throws(() => loadConfig({ ...base, ARCHIVE_DAYS: "-1" }), /ARCHIVE_DAYS/);
  assert.throws(() => loadConfig({ ...base, TZ: "Mars/Olympus" }), /TZ/);
  assert.equal(loadConfig({ ...base, TZ: "Europe/Rome" }).undoSeconds, 5);
});

// ---------- Round 2 review ----------

test("an answer without the card's revision is refused", async () => {
  const { body } = await bot("POST", "/api/bot/items", { kind: "choice", title: "Rev required", options: [{ label: "Yes" }] });
  assert.equal((await call("POST", `/api/ui/items/${body.id}/act`, { type: "choose", option: 0 })).status, 409);
  await act(body.id, { type: "dismiss" });
});

test("a report on a card that changed after the tap keeps the card open with a note", async () => {
  const { body } = await bot("POST", "/api/bot/items", { key: "changed-after", kind: "reminder", title: "v1" });
  await act(body.id, { type: "write", text: "handle it" });
  clock += 6000;
  const [a] = (await bot("GET", "/api/bot/actions")).body.actions;
  await bot("POST", "/api/bot/items", { key: "changed-after", kind: "reminder", title: "v2 with news" });
  await bot("POST", `/api/bot/actions/${a.id}`, { ok: true, result: "Handled" });
  const c = await card(body.id);
  assert.equal(c.status, "open");
  assert.match(c.error, /earlier version/);
  await act(body.id, { type: "dismiss" });
});

test("undo on a question about a read summary keeps it read", async () => {
  const { body } = await bot("POST", "/api/bot/items", { key: "wa:read-undo", section: "catchup", title: "Group", body: "stuff" });
  await act(body.id, { type: "read" });
  const tap = await act(body.id, { type: "write", text: "who said that?" });
  await call("POST", `/api/ui/actions/${tap.body.action.id}/undo`, {});
  assert.equal(s.store.getItem(body.id)!.status, "closed");
});

test("to-dos: a bot called todoist works without a Todoist link, and undo after completion is refused", async () => {
  await bot("PUT", "/api/bot/todos", { todos: [{ id: "x1", content: "From a bot named todoist" }] }, "todoist");
  assert.equal((await call("POST", "/api/ui/todos/complete", { bot: "todoist", id: "x1" })).status, 200);
  clock += 6000;
  const [a] = (await bot("GET", "/api/bot/actions", undefined, "todoist")).body.actions;
  await bot("POST", `/api/bot/actions/${a.id}`, { ok: true }, "todoist");
  assert.equal((await call("POST", "/api/ui/todos/complete", { bot: "todoist", id: "x1", undo: true })).status, 409);
});

test("a late failure on an old occurrence doesn't reopen the next one", async () => {
  await bot("PUT", "/api/bot/todos", { todos: [{ id: "occ", content: "Daily", due: "2026-12-01" }] }, "daily");
  await call("POST", "/api/ui/todos/complete", { bot: "daily", id: "occ" });
  clock += 6000;
  const [old] = (await bot("GET", "/api/bot/actions", undefined, "daily")).body.actions;
  clock += 21 * 60_000;
  s.store.expireClaims(20 * 60_000);
  await bot("PUT", "/api/bot/todos", { todos: [{ id: "occ", content: "Daily", due: "2026-12-02" }] }, "daily");
  await call("POST", "/api/ui/todos/complete", { bot: "daily", id: "occ" });
  await bot("POST", `/api/bot/actions/${old.id}`, { ok: false, result: "old run failed" }, "daily");
  assert.ok(s.store.findTodo("daily", "occ")!.completedAt, "the new occurrence stays completed");
});

test("archive: integer offsets only, and filtering by bot happens before paging", async () => {
  assert.equal((await call("GET", "/api/ui/archive?offset=0.5")).status, 200);
  for (let i = 0; i < 55; i++) await bot("POST", "/api/bot/items/close", { key: (await bot("POST", "/api/bot/items", { key: `bulk-${i}`, title: `Bulk ${i}` }, "bulk")).body.key, reason: "x" }, "bulk");
  await bot("POST", "/api/bot/items", { key: "lonely", title: "Only one" }, "lonely");
  await bot("POST", "/api/bot/items/close", { key: "lonely", reason: "done" }, "lonely");
  const res = (await call("GET", "/api/ui/archive?bot=lonely")).body;
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].title, "Only one");
});

test("an event ending at midnight doesn't show on the next day", () => {
  s.store.replaceEvents("cal", "2030-01-01", "2030-01-03", [
    { title: "Late show", start: "2030-01-01T22:00:00", end: "2030-01-02T00:00:00", location: "", allDay: false, app: "" },
    { title: "Two-day fair", start: "2030-01-01", end: "2030-01-02", location: "", allDay: true, app: "" },
  ]);
  const next = s.store.listEvents("2030-01-02", "2030-01-03").map((e) => e.title);
  assert.deepEqual(next, ["Two-day fair"]);
});

test("a scan records when it started", async () => {
  await bot("POST", "/api/bot/scan", { startedAt: "2026-10-12T10:00:00" }, "scanner");
  const res = (await bot("GET", "/api/bot/actions", undefined, "scanner")).body;
  assert.equal(res.lastScanAt, "2026-10-12T10:00:00");
});

test("webhooks: hex-mapped IPv6 loopback is private too", () => {
  assert.ok(isPrivateAddress("::ffff:7f00:1"));
  assert.notEqual(checkWebhookUrl("https://[::ffff:7f00:1]/hook", false), "");
});

test("taps queued before snapshots existed are cancelled on upgrade", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gbd-")), "old.db");
  const old = new Store(file, () => clock);
  const { item } = old.upsertItem({ bot: "dashboard", section: "needs", kind: "reminder", title: "Old tap" });
  old.addAction({ item, bot: "dashboard", type: "write", text: "x", delayMs: 0 });
  old.db.exec("UPDATE actions SET snapshot = NULL");
  old.close();
  const upgraded = new Store(file, () => clock);
  assert.equal(upgraded.getItem(item.id)!.status, "open");
  assert.equal(upgraded.claimActions("dashboard").length, 0);
  upgraded.close();
  fs.rmSync(path.dirname(file), { recursive: true });
});

test("direct Todoist: a double tap closes the task once", async () => {
  let closes = 0;
  const fake = (async (input: URL | RequestInfo) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/close")) closes++;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const store = new Store(":memory:", () => clock);
  const server = http.createServer(createApp({ config, store, todoist: new Todoist("tok", "", "Europe/Rome", fake), log: () => {} }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) => fetch(base + "/api/ui/todos/complete", { method: "POST", headers: { "Content-Type": "application/json", "Tailscale-User-Login": OWNER }, body: JSON.stringify(body) });
  const [a, b] = await Promise.all([post({ bot: "todoist", id: "42" }), post({ bot: "todoist", id: "42" })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(closes, 1);
  server.close();
  store.close();
});
