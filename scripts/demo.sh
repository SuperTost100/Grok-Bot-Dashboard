#!/usr/bin/env bash
# Fill a dashboard with made-up cards so you can see it working.
# Usage: GROKDASH_URL=http://127.0.0.1:8787 GROKDASH_TOKEN=dev-token scripts/demo.sh
set -euo pipefail
g="$(dirname "$0")/../bin/grokdash"
today=$(date +%F)
tomorrow=$(date -d tomorrow +%F 2>/dev/null || date -v+1d +%F)

GROKDASH_BOT=dashboard "$g" register '{"name":"Dashboard","color":"#1b1a17"}' >/dev/null
GROKDASH_BOT=venduto "$g" register '{"name":"Venduto","color":"#2f7d5b"}' >/dev/null
GROKDASH_BOT=comprato "$g" register '{"name":"Comprato","color":"#3b6fb6"}' >/dev/null

GROKDASH_BOT=dashboard "$g" post '{"items":[
 {"key":"demo:lab","kind":"choice","title":"Marco needs your vote on the lab swap","body":"Group 2 wants to move your Production lab to Monday 10:00. It is 4 to 4 and you have not voted.","context":"Tuesday 10:00 is already in your calendar.","source":"WhatsApp · Lab group","urgent":"answer by 14:00",
  "options":[{"label":"Vote Tuesday","instruction":"Vote Tuesday in the Lab group poll"},{"label":"Vote Monday","instruction":"Vote Monday in the Lab group poll"}]},
 {"key":"demo:sam","kind":"draft","title":"Sam asked how to check if his data leaked","body":"Someone on Discord knew part of his phone number.","source":"WhatsApp · Sam",
  "draft":{"to":"Sam","channel":"WhatsApp","text":"That sucks, sorry. Turn on two-factor on Discord and change the password there and on the linked email. Then check your email on haveibeenpwned.com."}},
 {"key":"demo:halloween","kind":"choice","title":"Halloween prep poll: 30th, 31st or not coming","body":"Richi proposes prepping the games on the afternoon of the 30th, then dinner together.","context":"You have scout camp overnight on the 30th.","source":"WhatsApp · Halloween crew",
  "options":[{"label":"Vote 30th, afternoon only"},{"label":"Vote 31st"},{"label":"Vote not coming"}]},
 {"key":"demo:stripe","kind":"reminder","title":"Perplexity payment of $244 failed again","body":"Update the card by Thursday or the subscription ends.","source":"Gmail · Stripe","link":"https://mail.google.com/"},
 {"key":"demo:gift","section":"catchup","title":"Gift for Luca","countLabel":"46 messages","body":"They dropped the F1 simulator. Luca picks between Zero Gravity and paintball, revealed with a treasure hunt. About 8 euro each."},
 {"key":"demo:uni","section":"catchup","title":"Uni mail","countLabel":"3 emails","body":"Tomorrow'"'"'s tech talk moved to Room 10C. I fixed the calendar event. The other two are newsletters."}
]}' >/dev/null

GROKDASH_BOT=venduto "$g" post '{"key":"demo:sonos","kind":"choice","title":"Can I counter Giulia at 45 euro?","body":"She offered 40 for the Sonos One. Your floor is 45 and the listing is at 55.","source":"Subito · Sonos One",
 "options":[{"label":"Yes, counter 45","instruction":"Counter Giulia at 45"},{"label":"No, hold at 55","instruction":"Tell Giulia the price stays 55"}]}' >/dev/null
GROKDASH_BOT=comprato "$g" post '{"key":"demo:sonoff","kind":"choice","title":"SONOFF ZBMINIL2 for 9 euro. Message the seller?","body":"Listed 20 minutes ago, 3 km away. Your max is 12.","source":"Subito · Torino",
 "options":[{"label":"Yes, ask if available"},{"label":"Skip this one"}]}' >/dev/null

GROKDASH_BOT=dashboard "$g" agenda "{\"app\":\"googlecalendar\",\"from\":\"$today\",\"events\":[
 {\"title\":\"Short film meeting\",\"start\":\"${today}T10:00\",\"end\":\"${today}T11:00\",\"location\":\"Urban vineyard\"},
 {\"title\":\"Io Sono Cultura\",\"start\":\"${today}T14:30\",\"end\":\"${today}T16:00\"},
 {\"title\":\"Gym\",\"start\":\"${today}T17:00\",\"end\":\"${today}T18:00\"},
 {\"title\":\"Production lab\",\"start\":\"${tomorrow}T10:00\",\"end\":\"${tomorrow}T11:30\",\"location\":\"Lab 3\"},
 {\"title\":\"NTT Data tech talk\",\"start\":\"${tomorrow}T14:30\",\"end\":\"${tomorrow}T16:00\",\"location\":\"Room 10C\"}]}" >/dev/null

GROKDASH_BOT=dashboard "$g" todos "{\"app\":\"todoist\",\"todos\":[
 {\"id\":\"d1\",\"content\":\"Io Sono Cultura comparison\",\"priority\":\"p1\",\"deadline\":\"$tomorrow\"},
 {\"id\":\"d2\",\"content\":\"Reply to CFR\",\"priority\":\"p2\",\"due\":\"$today\",\"project\":\"Work\"},
 {\"id\":\"d3\",\"content\":\"Upload field photos to Drive\",\"priority\":\"p3\",\"due\":\"$today\",\"project\":\"Scouts\"},
 {\"id\":\"d4\",\"content\":\"Monthly accounting\",\"priority\":\"p2\",\"due\":\"$tomorrow\",\"project\":\"Work\"}]}" >/dev/null

GROKDASH_BOT=dashboard "$g" scanned >/dev/null
echo "Demo data posted to $GROKDASH_URL"
