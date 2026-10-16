# Add-ons and apps

Add-ons and apps add sources and panels to the dashboard without changing its code. Both come from a **store**: a GitHub repo with a `store.json` that lists them. The default store is [SuperTost100/grokdash-store](https://github.com/SuperTost100/grokdash-store), which has Todoist, Calendar, Mail, WhatsApp, PoliTO, Shipments and Plan my day.

- An **add-on** is one script. It reads something (your mail, a calendar, an API) and posts cards, a panel, events or to-dos.
- An **app** runs its own containers, for things that need a service of their own, like the WhatsApp bridge.

## Installing

Open **Add-ons**. The store section lists what your stores offer. **Install** shows what it asks for and the settings it needs, and lets you choose whether to trust it. You can also paste a link to a single folder in any GitHub repo, or connect another store with `owner/repo`.

Every install is pinned to a commit. When the repo changes that folder, the add-on shows **Update available** with the commit messages, and nothing changes until you press Update.

## Trust

| | Not trusted | Trusted |
| --- | --- | --- |
| Where it runs | A container of its own, built from its folder | A process next to the dashboard |
| What it reaches | Its own cards, panel, agenda, to-dos and status | Also what it asks for: your mail and chats, agenda, to-dos, every card, handoffs to your bots, triage, Jev |
| What it could do if it were malicious | Use its own settings and the internet | Anything the dashboard can do |

A trusted add-on runs under Node's permission model, which keeps a mistake from reading files elsewhere or starting programs, but doesn't stop code written to break out. Trust an add-on when you'd run its code on this machine yourself. Changing trust restarts it with fresh saved data.

Untrusted add-ons and all apps need the Docker setup from `compose.yaml`: there the dashboard can tell your browser (which arrives through Docker's port mapping) from an add-on or an app, so none of them can pose as you.

## The runner

Apps and untrusted add-ons are started by the `runner` service in `compose.yaml`, the only part with access to Docker. It shares a private network with the dashboard and nothing else, answers only a key it creates on first start, and refuses anything in an app's compose file that could reach the host: privileged mode, host folders, published ports, the host network, unset values Compose would fill in from its environment, and service names that aren't the app's own. Each service gets a memory limit and loses raw sockets. Remove the `runner` service to turn apps and untrusted add-ons off.

## Writing one

See [Writing an add-on or an app](https://github.com/SuperTost100/grokdash-store/blob/main/docs/writing-addons.md) in the store repo. The bot API they use is in the [API reference](API.md).
