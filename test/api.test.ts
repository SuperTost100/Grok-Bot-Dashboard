import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { Todoist, pickTodos } from "../server/todoist.ts";
import type { Config } from "../server/config.ts";

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
  publicDir: new URL("../public", import.meta.url).pathname.replace(/\/$/, ""),
};

async function startServer(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const store = new Store(":memory:", () => clock);
  const pings: string[] = [];
  const server = http.createServer(
    createApp({ config, store, tz: "Europe/Rome", log: () => {}, notify: (bot, why) => pings.push(`${bot}:${why}`), ...extra }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, server, base, pings };
}

let s: Awaited<ReturnType<typeof startServer>>;
before(async () => { s = await startServer(); });
after(() => { s.server.close(); s.store.close(); });

async function call(method: string, path: string, body?: unknown, who: "bot" | "owner" | "stranger" | "nobody" = "owner") {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (who === "bot") headers.Authorization = `Bearer ${TOKEN}`;
  if (who === "owner") headers["Tailscale-User-Login"] = OWNER;
  if (who === "stranger") headers["Tailscale-User-Login"] = "someone@else.com";
  const res = await fetch(s.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
}

const bot = (method: string, path: string, body?: unknown) => call(method, path, body, "bot");

test("only the owner's Tailscale login opens the page and the UI API", async () => {
  assert.equal((await call("GET", "/", undefined, "nobody")).status, 403);
  assert.equal((await call("GET", "/api/ui/state", undefined, "stranger")).status, 403);
  const ok = await call("GET", "/");
  assert.equal(ok.status, 200);
  assert.match(String(ok.body), /<title>/);
});

test("the bot API needs the token, and the token doesn't open the UI", async () => {
  assert.equal((await call("GET", "/api/bot/items", undefined, "owner")).status, 401);
  assert.equal((await call("GET", "/api/ui/state", undefined, "bot")).status, 403);
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
});

test("a choice goes from card to bot and back, with an undo window", async () => {
  const posted = await bot("POST", "/api/bot/items", {
    bot: "dashboard",
    key: "wa:lab-poll",
    kind: "choice",
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
  assert.equal(posted.body.created, true);
  const id = posted.body.id;

  let state = (await call("GET", "/api/ui/state")).body;
  assert.equal(state.needs[0].title, "Marco needs your vote on the lab swap");

  // Tap, then undo inside the window: nothing reaches the bot.
  const first = await call("POST", `/api/ui/items/${id}/act`, { type: "choose", option: 0 });
  assert.equal(first.body.action.status, "queued");
  assert.equal((await call("POST", `/api/ui/actions/${first.body.action.id}/undo`, {})).status, 200);
  assert.equal((await bot("GET", "/api/bot/actions?bot=dashboard")).body.actions.length, 0);

  // Tap again and let the window pass.
  const second = await call("POST", `/api/ui/items/${id}/act`, { type: "choose", option: 1 });
  assert.equal((await call("POST", `/api/ui/items/${id}/act`, { type: "choose", option: 0 })).status, 409, "no double actions");
  clock += 6000;
  const claimed = (await bot("GET", "/api/bot/actions?bot=dashboard")).body.actions;
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].instruction, "Vote Monday in the Lab group poll");
  assert.equal(claimed[0].item.key, "wa:lab-poll");
  assert.equal((await call("POST", `/api/ui/actions/${second.body.action.id}/undo`, {})).status, 409, "too late to undo");

  // A second poll doesn't hand out the same action again.
  assert.equal((await bot("GET", "/api/bot/actions?bot=dashboard")).body.actions.length, 0);

  await bot("POST", `/api/bot/actions/${claimed[0].id}`, { ok: true, result: "Voted Monday" });
  state = (await call("GET", "/api/ui/state")).body;
  const card = state.needs.find((i: { id: number }) => i.id === id);
  assert.equal(card.status, "closed");
  assert.equal(card.resolution, "Voted Monday");

  // Once acknowledged it leaves Today but stays in the archive.
  await call("POST", `/api/ui/items/${id}/ack`, {});
  state = (await call("GET", "/api/ui/state")).body;
  assert.equal(state.needs.some((i: { id: number }) => i.id === id), false);
  const archive = (await call("GET", "/api/ui/archive?q=lab")).body.items;
  assert.equal(archive[0].id, id);
});

test("a claimed action that never reports back is handed out again after 20 minutes", async () => {
  const { body } = await bot("POST", "/api/bot/items", { bot: "dashboard", kind: "reminder", title: "Stale check" });
  await call("POST", `/api/ui/items/${body.id}/act`, { type: "write", text: "do it" });
  clock += 6000;
  assert.equal((await bot("GET", "/api/bot/actions?bot=dashboard")).body.actions.length, 1);
  clock += 21 * 60_000;
  const again = (await bot("GET", "/api/bot/actions?bot=dashboard")).body.actions;
  assert.equal(again.length, 1);
  await bot("POST", `/api/bot/actions/${again[0].id}`, { ok: true });
});

test("a failed action puts the card back with the reason", async () => {
  const { body } = await bot("POST", "/api/bot/items", {
    bot: "dashboard",
    kind: "draft",
    title: "Sam asked how to check if his data leaked",
    draft: { to: "Sam", channel: "WhatsApp", text: "Check haveibeenpwned.com" },
  });
  await call("POST", `/api/ui/items/${body.id}/act`, { type: "send", text: "Edited: check haveibeenpwned.com" });
  clock += 6000;
  const [a] = (await bot("GET", "/api/bot/actions?bot=dashboard")).body.actions;
  assert.equal(a.type, "send");
  assert.equal(a.text, "Edited: check haveibeenpwned.com");
  await bot("POST", `/api/bot/actions/${a.id}`, { ok: false, result: "WhatsApp is disconnected" });
  const card = (await call("GET", "/api/ui/state")).body.needs.find((i: { id: number }) => i.id === body.id);
  assert.equal(card.status, "open");
  assert.equal(card.error, "WhatsApp is disconnected");
});

test("posting the same key updates the card, and dismissed cards stay dismissed", async () => {
  const one = await bot("POST", "/api/bot/items", { bot: "venduto", key: "sonos", kind: "reminder", title: "v1" });
  const two = await bot("POST", "/api/bot/items", { bot: "venduto", key: "sonos", kind: "reminder", title: "v2" });
  assert.equal(two.body.id, one.body.id);
  assert.equal(two.body.created, false);
  await call("POST", `/api/ui/items/${one.body.id}/act`, { type: "dismiss" });
  const three = await bot("POST", "/api/bot/items", { bot: "venduto", key: "sonos", kind: "reminder", title: "v3" });
  assert.equal(three.body.ignored, true);
  const four = await bot("POST", "/api/bot/items", { bot: "venduto", key: "sonos", kind: "reminder", title: "v4", reopen: true });
  assert.equal(four.body.reopened, true);
});

test("a read catch-up summary comes back when it changes", async () => {
  const one = await bot("POST", "/api/bot/items", { bot: "dashboard", key: "wa:family", section: "catchup", title: "Family", body: "Dad sent links", countLabel: "3 messages" });
  await call("POST", `/api/ui/items/${one.body.id}/act`, { type: "read" });
  const same = await bot("POST", "/api/bot/items", { bot: "dashboard", key: "wa:family", section: "catchup", title: "Family", body: "Dad sent links", countLabel: "3 messages" });
  assert.equal(same.body.ignored, true);
  const changed = await bot("POST", "/api/bot/items", { bot: "dashboard", key: "wa:family", section: "catchup", title: "Family", body: "Mum called", countLabel: "5 messages" });
  assert.equal(changed.body.reopened, true);
});

test("the bot can close its own cards by key", async () => {
  await bot("POST", "/api/bot/items", { bot: "dashboard", key: "poll:old", kind: "reminder", title: "Old poll" });
  const closed = await bot("POST", "/api/bot/items/close", { bot: "dashboard", key: "poll:old", reason: "Poll closed" });
  assert.equal(closed.body.status, "closed");
  const archive = (await call("GET", "/api/ui/archive?q=Old")).body.items;
  assert.equal(archive[0].resolution, "Poll closed");
});

test("bad input gets a clear 400", async () => {
  const r1 = await bot("POST", "/api/bot/items", { bot: "dashboard", kind: "choice", title: "No options" });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /options/);
  const r2 = await bot("POST", "/api/bot/items", { bot: "Not A Slug!", title: "x" });
  assert.equal(r2.status, 400);
  const r3 = await bot("POST", "/api/bot/items", { bot: "dashboard", title: "x", link: "javascript:alert(1)" });
  assert.equal(r3.status, 400);
});

test("snoozed cards disappear and come back on time", async () => {
  const { body } = await bot("POST", "/api/bot/items", { bot: "dashboard", kind: "reminder", title: "Snooze me" });
  await call("POST", `/api/ui/items/${body.id}/act`, { type: "snooze", until: clock + 3600_000 });
  let state = (await call("GET", "/api/ui/state")).body;
  assert.equal(state.needs.some((i: { id: number }) => i.id === body.id), false);
  clock += 3601_000;
  state = (await call("GET", "/api/ui/state")).body;
  assert.equal(state.needs.find((i: { id: number }) => i.id === body.id).status, "open");
});

test("agenda times are stored in the server's local time", async () => {
  const day = "2026-10-12";
  await bot("PUT", "/api/bot/agenda", {
    bot: "dashboard",
    from: day,
    events: [
      { title: "Gym", start: "2026-10-12T15:00:00Z", end: "2026-10-12T16:00:00Z" },
      { title: "Tech talk", start: "2026-10-13T14:30", location: "Room 10C" },
      { title: "Holiday", start: "2026-10-13" },
    ],
  });
  const agenda = (await call("GET", "/api/ui/state")).body.agenda;
  assert.deepEqual(agenda.map((e: { start: string }) => e.start), ["2026-10-12T17:00:00", "2026-10-13", "2026-10-13T14:30:00"]);
  assert.equal(agenda.find((e: { title: string }) => e.title === "Holiday").allDay, true);
});

test("refresh pings bots that registered a webhook", async () => {
  await bot("POST", "/api/bot/register", { bot: "dashboard", name: "Dashboard", webhookUrl: "https://example.com/hook" });
  s.pings.length = 0;
  await call("POST", "/api/ui/refresh", {});
  assert.deepEqual(s.pings, ["dashboard:refresh"]);
  assert.equal((await bot("GET", "/api/bot/actions?bot=dashboard")).body.refreshRequested, true);
  await bot("POST", "/api/bot/scan", { bot: "dashboard" });
  assert.equal((await bot("GET", "/api/bot/actions?bot=dashboard")).body.refreshRequested, false);
});

test("without Todoist, to-dos come from a bot and completing one goes back to it", async () => {
  await bot("PUT", "/api/bot/todos", {
    bot: "dashboard",
    todos: [
      { id: "t1", content: "Reply to CFR", priority: "p2", due: "2026-10-12" },
      { id: "t2", content: "Someday", priority: "p4" },
    ],
  });
  let todos = (await call("GET", "/api/ui/state")).body.todos;
  assert.equal(todos.source, "bot");
  assert.deepEqual(todos.items.map((t: { id: string }) => t.id), ["t1"]);
  assert.equal(todos.hidden, 1);

  const done = await call("POST", "/api/ui/todos/t1/complete", {});
  assert.equal(done.body.state.todos.items.length, 0);
  await call("POST", "/api/ui/todos/t1/complete", { undo: true });
  todos = (await call("GET", "/api/ui/state")).body.todos;
  assert.equal(todos.items.length, 1);

  await call("POST", "/api/ui/todos/t1/complete", {});
  clock += 6000;
  const actions = (await bot("GET", "/api/bot/actions?bot=dashboard")).body.actions;
  assert.equal(actions[0].type, "complete_todo");
  assert.equal(actions[0].todoId, "t1");
});

test("Todoist tasks map p1 the right way round and sort by nearest date", async () => {
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
        ],
        next_cursor: null,
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const t = new Todoist("tok", "", fake);
  const all = await t.list();
  assert.equal(all.find((x) => x.id === "b")!.priority, 1);
  assert.equal(all[0].project, "Work");
  const { todos, hidden } = pickTodos(all, "2026-10-12");
  assert.deepEqual(todos.map((x) => x.id), ["b", "a"]);
  assert.equal(hidden, 1);
  await t.close("b");
  assert.ok(calls.includes("POST /api/v1/tasks/b/close"));
});
