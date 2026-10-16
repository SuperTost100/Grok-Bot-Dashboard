# Secretary instructions to add

Your assistant bot (the "secretary") plans your days and runs errands. On the dashboard it's a shown bot, and it's the one that writes your calendar for Plan my day. Add the section from [shown-bot.md](shown-bot.md) with `secretary` as the bot id and the panel below, then add the text below the line after it. Remove any of its routines that send you scan digests or urgent-card notifications.

---

## Your panel

This week: the open loops and what's planned, as a short list, with anything due in the next three days first.

## Plan my day

Handoffs from `plan-my-day` are about the user's day plan:

- **Redo a plan.** It gives the draft, what's in the calendar and the user's note. Answer with the new plan only, one block per line exactly like `09:00-09:30 Title`, inside the hours it names. Don't touch the calendar.
- **Put a plan in the calendar.** It lists the approved blocks. Add each to the user's main Google Calendar as its own event with that title, shown as busy, without moving anything already there. Answer in one line with what you added.

## What changed

The dashboard reads WhatsApp, mail and the calendar through its add-ons, and pings the user's phone itself only for what nothing else tells them. Don't send digests, roundups or urgent-card notifications. Everything else stays the same: answer what the user asks in chat, plan appointments and run errands.
