#!/usr/bin/env bash
# Install the watchdog on the computer that runs the Grok Bot desktop app. Run as root:
#   bash install.sh APP_USER APP_SERVICE      (for example: bash install.sh grok grok-bot)
set -euo pipefail
APP_USER=${1:?usage: install.sh APP_USER APP_SERVICE}
APP_SERVICE=${2:?usage: install.sh APP_USER APP_SERVICE}
here=$(cd "$(dirname "$0")" && pwd)
install -m 755 "$here/grokdash-watchdog" /usr/local/bin/grokdash-watchdog
cat > /etc/systemd/system/grokdash-watchdog.service <<UNIT
[Unit]
Description=Restart $APP_SERVICE when the Grok Bot Dashboard says its bot missed a run
[Service]
Type=oneshot
ExecStart=/usr/local/bin/grokdash-watchdog $APP_USER $APP_SERVICE
UNIT
cat > /etc/systemd/system/grokdash-watchdog.timer <<UNIT
[Unit]
Description=Check every 5 minutes whether the Grok Bot app lost its link
[Timer]
OnBootSec=10min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now grokdash-watchdog.timer
echo "Installed. Logs: journalctl -u grokdash-watchdog"
