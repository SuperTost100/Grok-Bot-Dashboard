# Triage with Jev

With WhatsApp or mail connected (see [WhatsApp, mail and calendar](sources.md)), the dashboard can sort new messages itself, so the Grok Bot only runs when something needs a reply or an answer. The sorting is done by [Jev](https://openrouter.ai/docs/guides/community/jev), a decision model on OpenRouter that answers questions with probabilities instead of text. It costs $0.042 per million input tokens. One decision is about 1,000 tokens, so 160 decisions cost under 1¢. Add an OpenRouter API key under Settings, Triage.

## How a message is sorted

Each burst of new messages in a chat or mail thread is one decision. Jev answers four questions: what it would cost you to look only tonight, what it needs from you (a reply, a decision, a task, information, nothing), whether it's addressed to you personally, and whether a machine sent it. The dashboard acts on Jev's probabilities, not on its single best guess:

| Jev says                                                          | What happens                                         | Grok runs?      |
| ----------------------------------------------------------------- | ---------------------------------------------------- | --------------- |
| Likely needs your reply or decision, clearly urgent               | Urgent card; Grok drafts the answer                  | Yes, right away |
| Likely needs your reply or decision                               | A card now; Grok writes the answer at its next run   | Later           |
| Might need a reply (35% to the "Grok works on a chat at" setting) | A line in Catch up, made from the message            | No              |
| A task, news for today, or a person writing to you privately      | A line in Catch up, made from the message            | No              |
| Group chatter that names you, or information that can wait       | A line in Catch up                                   | No              |
| Group chatter that isn't for you                                  | Straight to the archive, where search finds it       | No              |
| Noise or automatic mail                                           | Listed under "Filtered out today" in Catch up        | No              |

In a group, a question needs you only when it names you or asks you to decide. Mentions of you are rewritten as @your-name so Jev can tell. While you're chatting in a chat yourself (you wrote there in the last 15 minutes), its new messages need no decision. When you reply from your phone, the chat's card closes.

These rules were tuned on 165 real decisions against the cards the Grok bot made for the same messages. Jev rates almost any live chat message as urgent, so urgency only counts when it's clear-cut.

## Calendar events

Every burst, your own replies included, also gets two calendar questions: does it set a date for something you take part in, and does it name a specific day?

Something already set goes to the Grok Bot, which puts it in your main Google Calendar at its next run. A card says so meanwhile. That covers a confirmed appointment, an exam, a lesson that moved, a booking, a deadline you have to meet and a cancellation. A deadline with a time becomes an event at that time.

An open invitation gets a card with an "Add to calendar" button, and Grok runs only if you tap it. Dates in ads and newsletters, other people's plans in groups, and anything without a day ("let's talk this weekend", "I'm on my way") are left alone. On 223 real bursts this added 5 events and asked about none.

## When Grok wakes

Every bot runs on its own clock, and these rules decide when the dashboard wakes it for chats triage queued or for handoffs other bots left:

- **Urgent work** waits 3 minutes for anything else to arrive, then the bot runs once with everything queued for it, urgent or not.
- **Right after a run,** urgent work waits until 15 minutes have passed, so several urgent messages in a row cost one or two runs, not one each.
- **Other work** goes out together once the oldest piece has waited an hour and the bot hasn't run for an hour either.
- **A wake the bot never answered** isn't repeated until something new arrives.
- **Past 70 runs in a week,** counting every bot, only urgent work wakes a bot until Monday.

Your taps don't wait for any of this: they reach the bot once their undo window is over. The footer counts this week's runs. All these numbers are under Settings, Wakes.

## Turning it on

Triage starts in Shadow mode: Jev sorts and logs, but the page and Grok work as before, and Settings shows what triage would have done today. Switch Mode to On when its choices look right. Then Refresh only rereads your sources, and the Grok Bot needs the new instructions in [`bot/dashboard-bot.md`](../bot/dashboard-bot.md).

Triage never pings your phone: WhatsApp and your mail app already told you about the message. The phone pings under Settings are for things nothing else tells you about, a PoliTO deadline due tomorrow or a snoozed reminder coming back. They say how many and link to the dashboard, never what the card says.
