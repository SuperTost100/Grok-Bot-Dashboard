# API reference

Bots talk to the dashboard over HTTP with JSON. The `grokdash` command in `bin/` wraps every call below, so most bots never need this page.

## Authentication

| Caller   | Paths           | How it's checked                                                                       |
| -------- | --------------- | -------------------------------------------------------------------------------------- |
| Bots     | `/api/bot/*`    | `Authorization: Bearer <BOT_TOKEN>`                                                    |
| The page | everything else | the `Tailscale-User-Login` header that `tailscale serve` adds must equal `OWNER_LOGIN` |

Every bot call also needs a bot id: lowercase letters, digits and dashes, like `dashboard`. Send it as `"bot"` in the body, as `?bot=` in the query, or once in an `X-Bot` header. Writes must use `Content-Type: application/json`.

## Cards

A card is one thing that needs the user (section `needs`) or one catch-up summary (section `catchup`).

### Post or update a card

`POST /api/bot/items` with one card, or `{"items": [...]}` with up to 50.

| Field        | Required                   | Notes                                                                                                                                                                                                                   |
| ------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`        | strongly recommended       | Stable id for the source thread, like `wa:GROUP_ID:poll-1`. Posting the same key updates the card.                                                                                                                      |
| `kind`       | no, defaults to `reminder` | `choice`, `draft`, `reminder` or `digest`                                                                                                                                                                               |
| `section`    | no                         | `catchup` for digests, otherwise `needs`                                                                                                                                                                                |
| `title`      | yes                        | Up to 200 characters. What's needed, as a question or a statement.                                                                                                                                                      |
| `body`       | no                         | Up to 2000 characters. The facts needed to decide.                                                                                                                                                                      |
| `context`    | no                         | One line linking it to the calendar or to-dos.                                                                                                                                                                          |
| `source`     | no                         | Where it came from, like `WhatsApp · Lab group`.                                                                                                                                                                        |
| `app`        | no                         | Which app it came from, for the logo: `whatsapp`, `gmail`, `googlecalendar`, `mail` (any other mailbox), `github`, `todoist`, `subito`, `vinted`, `telegram` and more. Leave it out and the page guesses from `source`. |
| `link`       | no                         | `http(s)` link that opens the original.                                                                                                                                                                                 |
| `urgent`     | no                         | A few words with the deadline, like `answer by 14:00`. Urgent cards sort first and get a red outline.                                                                                                                   |
| `options`    | for `choice`               | 1 to 4 of `{"label": "Vote Tuesday", "instruction": "Vote Tuesday in the Lab group poll"}`. The first is shown as the main button.                                                                                      |
| `draft`      | for `draft`                | `{"to": "Sam", "channel": "WhatsApp", "text": "..."}`                                                                                                                                                                   |
| `countLabel` | for `digest`               | Short label like `46 messages`.                                                                                                                                                                                         |
| `reopen`     | no                         | `true` to bring back a card the user closed. Without it, posting a closed card's key does nothing and returns `"ignored": true`. Catch-up digests reopen on their own when their text changes.                          |

Response:

```json
{
  "id": 12,
  "key": "wa:GROUP_ID:poll-1",
  "status": "open",
  "created": true,
  "reopened": false,
  "ignored": false
}
```

### List your cards

`GET /api/bot/items?status=open` (or `closed`, `all`). Optional `section=needs|catchup`.

### Close a card

`POST /api/bot/items/close` with `{"key": "...", "reason": "Poll closed"}` or `{"id": 12, "reason": "..."}`. The reason shows in the archive.

## Taps from the page

When the user taps a button that reaches the outside world (an answer, a draft, a written instruction), the dashboard holds it for `UNDO_SECONDS` (5 by default) so it can be undone. Then it becomes an action for the bot that posted the card. If the bot registered a webhook, the dashboard calls it right away.

### Take waiting actions

`GET /api/bot/actions` claims every waiting action for this bot:

```json
{
  "actions": [
    {
      "id": 7,
      "type": "choose",
      "label": "Vote Tuesday",
      "instruction": "Vote Tuesday in the Lab group poll",
      "text": "",
      "todoId": null,
      "card": {
        "id": 12,
        "key": "wa:GROUP_ID:poll-1",
        "rev": 3,
        "title": "...",
        "body": "...",
        "context": "",
        "source": "WhatsApp · Lab group",
        "app": "whatsapp",
        "link": "",
        "draft": null
      }
    }
  ],
  "refreshRequested": false,
  "lastScanAt": "2026-10-12T16:44:10",
  "now": "2026-10-12T17:02:31",
  "timeZone": "Europe/Rome"
}
```

| `type`          | Meaning                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `choose`        | The user picked an option. Do `instruction`, or `label` if there's no instruction.                      |
| `send`          | Send `text` exactly as written to `card.draft.to` on `card.draft.channel`. The user may have edited it. |
| `write`         | `text` is a free-form instruction from the user about the card.                                         |
| `complete_todo` | Mark to-do `todoId` done. Only used when to-dos come from a bot.                                        |

`card` is the card exactly as the user saw it when they tapped, even if you updated it since. Act on that. Each action is handed out once. If it isn't reported within 20 minutes, it isn't handed out again, because it may already have happened: the card comes back to the user with a note to check. `refreshRequested` is `true` after the user presses refresh; do a full scan, then call `/api/bot/scan`. `lastScanAt` is when your last complete scan began: look for new messages since then.

### Report an action

`POST /api/bot/actions/:id` with `{"ok": true, "result": "Voted Tuesday"}` or `{"ok": false, "result": "WhatsApp is disconnected"}`. Success closes the card and shows the result on it. Failure puts the card back with the reason. Only the bot that took the action can report it, only after taking it (409 otherwise), and a second report changes nothing.

## Agenda

`PUT /api/bot/agenda` replaces every event of this bot that overlaps `from` to `to` (dates; `to` is exclusive and defaults to `from` plus 2 days). Send the complete list for that window each time. Every event must overlap the window, or the call fails with 400.

```json
{
  "from": "2026-10-12",
  "events": [
    {
      "title": "Gym",
      "start": "2026-10-12T17:00:00+02:00",
      "end": "2026-10-12T18:00:00+02:00",
      "location": ""
    }
  ]
}
```

Add `"app": "googlecalendar"` (or another app) at the top level or per event to show its logo. `start` and `end` take a date (`2026-10-13`, an all-day event) or a datetime with or without an offset. Impossible dates like `2026-02-30` or `25:00` are refused. The dashboard stores times in its own time zone (`TZ`). An event spanning several days shows on each of them.

## To-dos

Only used when the server has no `TODOIST_TOKEN`. `PUT /api/bot/todos` replaces this bot's whole list, so send every open to-do. Ids must be unique:

```json
{
  "todos": [
    {
      "id": "8123",
      "content": "Reply to CFR",
      "priority": "p2",
      "due": "2026-10-12",
      "deadline": "2026-10-14",
      "project": "Work",
      "url": ""
    }
  ]
}
```

Add `"app": "todoist"` to show its logo. The page shows what's overdue, due or with a deadline in the next 7 days, plus anything `p1` or `p2`.

## Bot settings and scans

| Call                     | Body                                                                                                          | Effect                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/bot/register` | `{"name": "Dashboard", "color": "#d9822b", "webhookUrl": "https://...", "webhookToken": "..."}`, all optional | Sets how the bot appears, and the webhook the dashboard calls when actions are waiting or the user presses refresh, with `webhookToken` sent as `Authorization: Bearer`. `""` clears either. |
| `POST /api/bot/scan`     | `{"startedAt": "2026-10-12T17:02:31"}`, optional                                                              | Marks a finished full scan. Send the time the scan began (the `now` from `/api/bot/actions`), so the next scan looks back to there. The page shows "Updated N min ago".                      |

The webhook receives a `POST` with `{"source": "grok-bot-dashboard", "reason": "actions" or "refresh", "message": "..."}`, at most once every 20 seconds per bot. While actions wait unclaimed, the ping repeats every 3 minutes. Webhook URLs must be public `https` addresses: the server refuses this machine, private networks and tailnet addresses (set `WEBHOOK_ALLOW_PRIVATE=1` to allow them) and never follows redirects. Changing the URL without sending a new `webhookToken` clears the old key.

`GET /api/bot/help` (or `grokdash guide`) returns this reference in short form, with field limits, the server's time zone and an example card.

## Rules for keys and sections

- A key names one decision, not a whole chat: a new question in the same chat needs a new key. Reusing the key of a card the user closed does nothing (`"ignored": true`), even after the card has left the archive.
- `section: "catchup"` takes only `digest` cards, and `digest` only goes in `catchup`. `options` only work on `choice`.
- Reposting a card with identical content changes nothing. Changed content bumps the card's revision, and a tap the user made on the old version is refused.

## Errors

Errors come back as `{"error": "what went wrong"}` with a 4xx status: 400 for bad input (the message names the field), 401 for a wrong token, 404 for unknown ids, 409 when it's too late to undo or the card is already being handled.
