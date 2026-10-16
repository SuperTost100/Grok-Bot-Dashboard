# PoliTO avvisi

Course avvisi from the Politecnico di Torino don't arrive by email, so the dashboard reads them from [areadidattica](https://github.com/SuperTost100/areadidattica-cli), a small local service over the API behind the official PoliTO Students app. No Grok Bot is involved, so it costs nothing from your Grok allowance.

- **When it checks.** At the Dashboard bot's scheduled run times (every 2 hours when no bot has sent its schedule), when you press Refresh, and once when the server starts.
- **What becomes a card.** Every unread avviso and school message, under its course name, with the avviso's first real line as the title. Tables in an avviso, like an exam timetable, show as tables. Emergency messages are marked urgent. PoliTO's deadlines for the next 30 days go on the agenda.
- **Marking read.** "Mark as read" or dismiss marks it read on PoliTO, so the phone app stops counting it. If PoliTO can't be reached, the next check tries again. Avvisi you read in the phone app close here at the next check. Snooze changes nothing on PoliTO.
- **No answers.** PoliTO cards have no Write button, because no bot would receive the message.

When a check fails, the page says why in the banner under the header. The cards already on the page stay.

## Set it up

Run areadidattica with Docker on the same machine (see its README), then add this to the dashboard's `.env` and run `docker compose up -d` again:

```bash
AREADIDATTICA_URL=http://areadidattica:8789
AREADIDATTICA_TOKEN=<API_TOKEN from areadidattica's .env>
COMPOSE_FILE=compose.yaml:compose.polito.yaml
```

`compose.polito.yaml` puts the dashboard on areadidattica's Compose network, which is named after the folder areadidattica runs from. The default, `areadidattica_default`, fits a folder called `areadidattica`. For another folder, set `AREADIDATTICA_NETWORK=<folder>_default`. Without Docker, use `AREADIDATTICA_URL=http://127.0.0.1:8789` and skip `COMPOSE_FILE`.
