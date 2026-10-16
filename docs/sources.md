# WhatsApp, mail and calendar

The dashboard can read your WhatsApp, up to three mailboxes and your calendars itself, so the Grok Bot doesn't have to scan them on a schedule. Everything here is read-only: it never sends, marks read, moves or deletes anything. Set it up under Settings on the page.

- **WhatsApp.** It goes through [WAHA](https://waha.devlike.pro), which links to your account as a device, like WhatsApp Web. Add `WAHA_API_KEY=<random secret>` to `.env`, add `compose.whatsapp.yaml` to `COMPOSE_FILE`, and run `docker compose up -d`. Then open Settings and scan the QR code under WhatsApp 1 with your phone. A code lasts a few minutes. If it expires, press "Show a new QR code". For a second number, like a business one, also add `compose.whatsapp2.yaml` and link it under WhatsApp 2, because the free WAHA links one number per container. The dashboard reads new messages every minute. WAHA is set never to show as online, so WhatsApp keeps sending notifications to your phone.
- **Mail.** It is read over IMAP every 2 minutes: new mail in the inbox, and your own replies in the Sent folder. For Gmail, create an app password in your Google Account and use that, not your normal password.
- **Calendar.** It comes from each calendar's secret iCal address, read every 15 minutes. In Google Calendar it's under Settings, your calendar, Integrate calendar. With an address set, the agenda shows those calendars and PoliTO deadlines, and agenda updates from bots are ignored.

The first time a mailbox or WhatsApp is read, the dashboard looks back 3 days. Message text stays in `data/dashboard.db` for 14 days. Settings shows when each source was last read, and the banner on Today says when one has been failing for more than 10 minutes.

To sort what comes in without waking the Grok Bot for every message, turn on [triage](triage.md).
