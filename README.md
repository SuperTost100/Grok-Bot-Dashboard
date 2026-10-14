<img src="public/icon-192.png" width="64" height="64" alt="">

# Grok Bot Dashboard

Grok Bot Dashboard is one page for everything your Grok Bots want from you: the questions waiting for an answer, your to-dos, today's agenda and a catch-up of busy chats. You answer with a tap instead of scrolling a chat thread.

It runs on your own computer and opens only on your Tailscale network, for your Tailscale account. There's no account to create and nothing to pay for beyond the Grok Bot subscription you already have.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/today-dark.png">
  <img alt="The Today page with demo data: six cards under Needs you, led by an urgent vote on a lab swap with Vote Tuesday and Vote Monday buttons, then to-dos from Todoist on the right, today's and tomorrow's agenda, and two catch-up summaries." src="docs/screenshots/today-light.png">
</picture>

## What it does

1. **Collects what needs you.** Your bots post cards: a question with suggested answers, a reply they drafted, a yes/no approval, a reminder. Urgent ones sort first with their deadline.
2. **Lets you answer in one tap.** Pick an answer, send or edit a draft, snooze, or write the bot an instruction. Anything that reaches other people waits 5 seconds with Undo, then goes to the bot that posted the card.
3. **Shows your day.** To-dos straight from Todoist (tick them off on the page), today's and tomorrow's agenda, and one-paragraph summaries of busy group chats and mailboxes.
4. **Brings in PoliTO avvisi.** Optional: unread course avvisi and school messages from the Politecnico di Torino become cards, and marking one read here marks it read in the PoliTO app too.
5. **Keeps a 30-day archive.** Everything you answered, dismissed or snoozed, searchable, with what the bot did about it.

On a phone, add it to your home screen and it opens full screen like an app.

## How it fits with Grok Bot

A Grok Bot named "Dashboard" scans your WhatsApp, mail and calendar on a schedule (every 2 hours by default) and posts cards with the `grokdash` command. When you tap something, the dashboard calls the bot's webhook routine and the bot acts within seconds. Your existing secretary bot stops sending digests and only notifies you when a card is urgent. Any other bot can post cards too, and gets its own filter on the page.

[Set up the bots](bot/README.md) after the dashboard runs.

## Requirements

- Docker with Compose, or Node.js 24 or newer.
- [Tailscale](https://tailscale.com) on the machine that runs the dashboard and on the devices you open it from.
- The Grok Bot desktop app on a computer in the same tailnet. Your bots run their commands there.
- Optional: a Todoist API token. Without one, a bot sends your to-dos instead.
- Optional: [areadidattica](https://github.com/SuperTost100/areadidattica-cli) running on the same machine, for PoliTO avvisi.

## Start

```bash
git clone https://github.com/SuperTost100/Grok-Bot-Dashboard.git
cd Grok-Bot-Dashboard
cp .env.example .env
```

Open `.env` and set `OWNER_LOGIN` to your Tailscale login and `BOT_TOKEN` to a random secret:

```bash
openssl rand -hex 24
```

`.env` holds that secret, so make it readable by you only:

```bash
chmod 600 .env
```

Create the data folder yourself so it belongs to you rather than to root, then start the container. It runs as user and group 1000; if `id -u` prints something else, set `DASHBOARD_UID` and `DASHBOARD_GID` in `.env` first.

```bash
mkdir -p data
docker compose up -d --build
```

The dashboard listens on `127.0.0.1:8787`, so only this machine can reach it. Put it on your tailnet with HTTPS:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

Open `https://<machine-name>.<tailnet>.ts.net:8443` from any of your devices. Anyone else on the tailnet gets "This dashboard only opens for its owner's Tailscale account."

### Try it with demo data

No Docker or Tailscale needed:

```bash
npm run dev
```

In a second terminal:

```bash
GROKDASH_URL=http://127.0.0.1:8788 GROKDASH_TOKEN=dev-token scripts/demo.sh
```

Open `http://127.0.0.1:8788`. `npm run dev` turns off the Tailscale check and keeps its data in `data-dev/`, apart from a real install's `data/`. Delete `data-dev/` when you're done.

## Configuration

Set these in `.env`. The full list with comments is in [`.env.example`](.env.example).

The Settings tab on the page changes the undo window, the archive and backup length, Todoist and PoliTO without a restart. A value saved there wins over `.env` until you press Reset. Tokens saved there are stored in `data/dashboard.db` and never sent back to the page. Your login, the bot token, the port, the time zone and the webhook rule stay in `.env` only.

| Variable                      | Required | Default     | What it does                                                             |
| ----------------------------- | -------- | ----------- | ------------------------------------------------------------------------ |
| `OWNER_LOGIN`                 | yes      |             | The Tailscale login allowed to open the page                             |
| `BOT_TOKEN`                   | yes      |             | Secret the bots send with every call                                     |
| `TZ`                          | no       | system zone | Time zone for "today", the agenda and to-do dates                        |
| `TODOIST_TOKEN`               | no       |             | Read and complete to-dos in Todoist directly                             |
| `TODOIST_FILTER`              | no       |             | Show only tasks matching a Todoist filter, like `today \| overdue \| p1` |
| `AREADIDATTICA_URL`           | no       |             | Where areadidattica answers; turns on PoliTO avvisi                      |
| `AREADIDATTICA_TOKEN`         | with URL |             | The `API_TOKEN` from areadidattica's `.env`                              |
| `WAHA_API_KEY`                | no       |             | Secret shared by WAHA and the dashboard; turns on WhatsApp               |
| `MAIL1_HOST` ... `MAIL3_HOST` | no       |             | IMAP server of each mailbox, with `_NAME`, `_USER` and `_PASSWORD`       |
| `CALENDAR_URLS`               | no       |             | Secret iCal addresses, separated by spaces                               |
| `UNDO_SECONDS`                | no       | `5`         | How long a tap waits before it goes to the bot                           |
| `ARCHIVE_DAYS`                | no       | `30`        | How long closed cards stay in the archive                                |
| `PORT`                        | no       | `8787`      | Port on `127.0.0.1`                                                      |
| `BACKUP_DAYS`                 | no       | `7`         | Daily backups kept in `data/backups`; `0` turns them off                 |
| `WEBHOOK_ALLOW_PRIVATE`       | no       | `0`         | `1` lets bots register webhooks on your LAN or tailnet                   |
| `AUTH_MODE`                   | no       | `tailscale` | `none` turns off the owner check. Only for local development.            |

## PoliTO avvisi

Course avvisi from the Politecnico di Torino don't arrive by email, so the dashboard reads them from [areadidattica](https://github.com/SuperTost100/areadidattica-cli), a small local service over the API behind the official PoliTO Students app. No Grok Bot is involved, so it costs nothing from your Grok allowance.

- **When it checks.** At the Dashboard bot's scheduled run times (every 2 hours when no bot has sent its schedule), when you press Refresh, and once when the server starts.
- **What becomes a card.** Every unread avviso and school message, under its course name, with the avviso's first real line as the title. Tables in an avviso, like an exam timetable, show as tables. Emergency messages are marked urgent. PoliTO's deadlines for the next 30 days go on the agenda.
- **Marking read.** "Mark as read" or dismiss marks it read on PoliTO, so the phone app stops counting it. If PoliTO can't be reached, the next check tries again. Avvisi you read in the phone app close here at the next check. Snooze changes nothing on PoliTO.
- **No answers.** PoliTO cards have no Write button, because no bot would receive the message.

When a check fails, the page says why in the banner under the header. The cards already on the page stay.

To set it up, run areadidattica with Docker on the same machine (see its README), then add this to the dashboard's `.env` and run `docker compose up -d` again:

```bash
AREADIDATTICA_URL=http://areadidattica:8789
AREADIDATTICA_TOKEN=<API_TOKEN from areadidattica's .env>
COMPOSE_FILE=compose.yaml:compose.polito.yaml
```

`compose.polito.yaml` puts the dashboard on areadidattica's Compose network, which is named after the folder areadidattica runs from. The default, `areadidattica_default`, fits a folder called `areadidattica`; for another folder, set `AREADIDATTICA_NETWORK=<folder>_default`. Without Docker, use `AREADIDATTICA_URL=http://127.0.0.1:8789` and skip `COMPOSE_FILE`.

## WhatsApp, mail and calendar

The dashboard can read your WhatsApp, up to three mailboxes and your calendars itself, so the Grok Bot doesn't have to scan them on a schedule. Everything here is read-only: it never sends, marks read, moves or deletes anything. Set it up under Settings on the page.

- **WhatsApp** goes through [WAHA](https://waha.devlike.pro), which links to your account as a device, like WhatsApp Web. Add `WAHA_API_KEY=<random secret>` to `.env`, add `compose.whatsapp.yaml` to `COMPOSE_FILE`, and run `docker compose up -d`. Then open Settings and scan the QR code under WhatsApp 1 with your phone. A code lasts a few minutes; if it expires, press "Show a new QR code". For a second number, like a business one, also add `compose.whatsapp2.yaml` and link it under WhatsApp 2: the free WAHA links one number per container. The dashboard reads new messages every minute. WAHA is set never to show as online, so WhatsApp keeps sending notifications to your phone.
- **Mail** is read over IMAP every 2 minutes: new mail in the inbox, and your own replies in the Sent folder. For Gmail, create an app password in your Google Account and use that, not your normal password.
- **Calendar** comes from each calendar's secret iCal address, read every 15 minutes. In Google Calendar it's under Settings, your calendar, Integrate calendar. With an address set, the agenda shows those calendars and PoliTO deadlines, and agenda updates from bots are ignored.

The first time a mailbox or WhatsApp is read, the dashboard looks back 3 days. Message text stays in `data/dashboard.db` for 14 days. Settings shows when each source was last read, and the banner on Today says when one has been failing for more than 10 minutes.

## Triage with Jev

With WhatsApp or mail connected, the dashboard can sort new messages itself, so the Grok Bot only runs when something needs a reply or an answer. The sorting is done by [Jev](https://openrouter.ai/docs/guides/community/jev), a decision model on OpenRouter that answers questions with probabilities instead of text. It costs $0.042 per million input tokens; one decision is about 500 tokens. Add an OpenRouter API key under Settings, Triage.

Each burst of new messages in a chat or mail thread is one decision. Jev answers three questions: how soon you need to see it (never, whenever, this week, today, now), what it needs from you (a reply, a decision, a task, information, nothing), and whether a machine sent it. Then:

| Jev says                          | What happens                                         | Grok runs?      |
| --------------------------------- | ---------------------------------------------------- | --------------- |
| Reply or decision, needed now     | Urgent card and a phone ping; Grok drafts the answer | Yes, right away |
| Reply or decision, later          | A card now; Grok writes the answer at its next run   | Later           |
| A task for you, or news for today | A card made from the message                         | No              |
| Information that can wait         | A line in Catch up                                   | No              |
| Noise or automatic mail           | Listed under "Filtered out today" in Catch up        | No              |

When Jev is unsure, the message counts as more urgent, so a doubt costs a card rather than a missed message. When you reply from your phone, the chat's card closes.

Grok wakes for chats that need it at most once every 45 minutes and takes everything waiting in one run. Chats due today wake it when 3 are waiting or the oldest has waited 2 hours, and anything left waits at most a day. After 10 Grok runs in a day, message wakes stop until the next day; your taps always go through. The footer counts Grok runs. All these numbers are on the Settings page.

Triage starts in Shadow mode: Jev sorts and logs, but the page and Grok work as before, and Settings shows what triage would have done today. Switch Mode to On when its choices look right. Then Refresh only rereads your sources, and the Grok Bot needs the new instructions in [`bot/dashboard-bot.md`](bot/dashboard-bot.md).

For urgent cards, set an [ntfy](https://ntfy.sh) topic under Phone pings and subscribe to it in the ntfy app. The ping says how many urgent cards wait and links to the dashboard, never what they say.

## Your data

Everything lives in one SQLite file, `data/dashboard.db`, readable by your user only. These are the only things the server sends off the machine:

- **Webhook calls.** When you tap or press refresh, the server calls the webhook URL each bot registered, with no card content in it.
- **Todoist.** With `TODOIST_TOKEN` set, it reads your active tasks and completes or reopens the ones you tick.
- **Triage.** With an OpenRouter key set, the text of new messages (up to 15 per decision, cut to 1,500 characters each) goes to OpenRouter and Jev's provider, TypeSafe.
- **Phone pings.** With an ntfy topic set, urgent cards send a count and a link to that topic.
- **WhatsApp, mail and calendars.** When you set them up, it reads them through WAHA, IMAP and the iCal addresses you gave it, as described above.
- **areadidattica.** With `AREADIDATTICA_URL` set, it asks that local service for unread avvisi and deadlines, and tells it which ones you marked read. areadidattica is the one that talks to PoliTO.

The bots read your chats and mail inside Grok Bot, as they already do, and post only the summaries you see.

### Backups

The server writes a consistent copy of the database to `data/backups/` once a day and keeps the last 7. Don't copy `dashboard.db` by hand while it runs: SQLite keeps recent changes in a side file, and a plain copy can come out broken. For a backup right now:

```bash
docker compose exec dashboard node server/backup.ts
```

It prints where it wrote the file and checks that the copy opens. To restore one, stop the container, put the backup in place of `data/dashboard.db`, delete `data/dashboard.db-wal` and `data/dashboard.db-shm`, and start it again.

## Development

```bash
npm ci
npm test
npm run check
```

`npm test` runs the API tests and `npm run check` typechecks. The server is plain TypeScript run by Node 24 directly, with no build step and no runtime dependencies: HTTP, SQLite and `fetch` all come from Node. The page is plain HTML, CSS and JavaScript in `public/`.

## Documentation

| Read this                                          | To learn                                                    |
| -------------------------------------------------- | ----------------------------------------------------------- |
| [Set up the bots](bot/README.md)                   | Install `grokdash`, create the Dashboard bot, add a webhook |
| [Dashboard bot instructions](bot/dashboard-bot.md) | The prompt that makes a Grok Bot keep the page current      |
| [Secretary changes](bot/secretary.md)              | Turn your current assistant into the urgent-card notifier   |
| [API reference](docs/API.md)                       | Every endpoint, for bots that don't use `grokdash`          |

## License

MIT, see [`LICENSE`](LICENSE).
