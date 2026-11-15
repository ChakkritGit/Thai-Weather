#!/bin/bash
# Sets up the daily VPS backup on the Mac: the script outside the SSD (launchd must find it even when the SSD is
# missing, to report that), an hourly launchd agent, and the `vps-backup` SSH host (a key that can only run
# /usr/local/sbin/backup-export on the server). The key, the passphrase (Keychain) and the server side are made
# once by hand; see HANDOFF.md.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
app="$HOME/Library/Application Support/vps-backup"
label=com.chakkritton.vps-backup
plist="$HOME/Library/LaunchAgents/$label.plist"

mkdir -p "$app" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
install -m 755 "$here/pull-vps-backup.sh" "$app/pull-vps-backup.sh"

cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$app/pull-vps-backup.sh</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed: $label (hourly; one bundle a day into /Volumes/SSD256GB/Backups/vps, newest 3 kept)"
