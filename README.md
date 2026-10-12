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
4. **Keeps a 30-day archive.** Everything you answered, dismissed or snoozed, searchable, with what the bot did about it.

On a phone, add it to your home screen and it opens full screen like an app.

## How it fits with Grok Bot

A Grok Bot named "Dashboard" scans your WhatsApp, mail and calendar every 30 minutes and posts cards with the `grokdash` command. When you tap something, the dashboard calls the bot's webhook routine and the bot acts within seconds. Your existing secretary bot stops sending digests and only notifies you when a card is urgent. Any other bot can post cards too, and gets its own filter on the page.

[Set up the bots](bot/README.md) after the dashboard runs.

## Requirements

- Docker with Compose, or Node.js 24 or newer.
- [Tailscale](https://tailscale.com) on the machine that runs the dashboard and on the devices you open it from.
- The Grok Bot desktop app on a computer in the same tailnet. Your bots run their commands there.
- Optional: a Todoist API token. Without one, a bot sends your to-dos instead.

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

| Variable                | Required | Default     | What it does                                                             |
| ----------------------- | -------- | ----------- | ------------------------------------------------------------------------ |
| `OWNER_LOGIN`           | yes      |             | The Tailscale login allowed to open the page                             |
| `BOT_TOKEN`             | yes      |             | Secret the bots send with every call                                     |
| `TZ`                    | no       | system zone | Time zone for "today", the agenda and to-do dates                        |
| `TODOIST_TOKEN`         | no       |             | Read and complete to-dos in Todoist directly                             |
| `TODOIST_FILTER`        | no       |             | Show only tasks matching a Todoist filter, like `today \| overdue \| p1` |
| `UNDO_SECONDS`          | no       | `5`         | How long a tap waits before it goes to the bot                           |
| `ARCHIVE_DAYS`          | no       | `30`        | How long closed cards stay in the archive                                |
| `PORT`                  | no       | `8787`      | Port on `127.0.0.1`                                                      |
| `BACKUP_DAYS`           | no       | `7`         | Daily backups kept in `data/backups`; `0` turns them off                 |
| `WEBHOOK_ALLOW_PRIVATE` | no       | `0`         | `1` lets bots register webhooks on your LAN or tailnet                   |
| `AUTH_MODE`             | no       | `tailscale` | `none` turns off the owner check. Only for local development.            |

## Your data

Everything lives in one SQLite file, `data/dashboard.db`, readable by your user only. These are the only things the server sends off the machine:

- **Webhook calls.** When you tap or press refresh, the server calls the webhook URL each bot registered, with no card content in it.
- **Todoist.** With `TODOIST_TOKEN` set, it reads your active tasks and completes or reopens the ones you tick.

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
