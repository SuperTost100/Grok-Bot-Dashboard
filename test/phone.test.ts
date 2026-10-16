import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.ts";
import { Settings } from "../server/settings.ts";
import { loadConfig } from "../server/config.ts";
import { createPhone, PHONE_GAP_MS } from "../server/ntfy.ts";
import { POLITO_BOT } from "../server/polito.ts";

const TZ = "Europe/Rome";

function setup(start: string) {
  let clock = Date.parse(start);
  const store = new Store(":memory:", () => clock);
  const settings = new Settings(store, loadConfig({ OWNER_LOGIN: "o@x.com", BOT_TOKEN: "test-token-123", TZ }), {});
  settings.update({ ntfyTopic: "secret-topic", dashboardUrl: "https://dash.example" });
  const sent: string[] = [];
  const phone = createPhone({
    store, settings, tz: TZ, log: () => {},
    fetch: (async (_u: unknown, init?: RequestInit) => { sent.push(String(init?.body)); return new Response("{}"); }) as typeof fetch,
  });
  return { store, settings, phone, sent, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

test("pings: a PoliTO deadline once, the morning before, never at night", async () => {
  const t = setup("2026-10-13T05:30:00Z"); // 07:30 in Rome
  t.store.ensureBot(POLITO_BOT);
  t.store.replaceEvents(POLITO_BOT, "2026-10-13", "2026-11-12", [{ title: "Consegna", start: "2026-10-14", end: "", location: "", allDay: true, app: "polito" }]);
  await t.phone.tick();
  assert.deepEqual(t.sent, [], "before 8:00");
  t.advance(60 * 60_000);
  await t.phone.tick();
  assert.deepEqual(t.sent, ["1 deadline is due tomorrow"]);
  t.advance(2 * PHONE_GAP_MS);
  await t.phone.tick();
  assert.equal(t.sent.length, 1, "once per deadline");
});

test("pings: reminders that come back, one ping an hour at most, none while away or without a topic", async () => {
  const t = setup("2026-10-13T10:00:00Z");
  await t.phone.ping("reminder");
  await t.phone.ping("reminder", 2);
  assert.deepEqual(t.sent, ["1 reminder is back"]);
  t.advance(PHONE_GAP_MS);
  await t.phone.tick();
  assert.deepEqual(t.sent, ["1 reminder is back", "2 reminders are back"], "what waited goes out after the gap");
  t.advance(PHONE_GAP_MS);
  t.store.setAway({ from: t.now(), until: t.now() + 86_400_000, summarized: false });
  await t.phone.ping("reminder");
  t.store.setAway(null);
  t.settings.update({ ntfyTopic: null });
  await t.phone.ping("reminder");
  assert.equal(t.sent.length, 2);
});
