#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"
source device/common.sh
python3 device/setup.py register
python3 device/setup.py verify-backup
python3 device/branding.py restore
backup="$backup/supervisord.conf"
"$adb_bin" -s "$serial" push "$backup" /var/carthing/supervisord.original.conf
"$adb_bin" -s "$serial" shell 'set -e; mount -o remount,rw /; trap "mount -o remount,ro /" EXIT; cp /var/carthing/supervisord.original.conf /etc/supervisord.restore.new && chmod 644 /etc/supervisord.restore.new && mv /etc/supervisord.restore.new /etc/supervisord.conf && sync'
"$adb_bin" -s "$serial" shell 'supervisorctl reread && supervisorctl update'
print 'Original display startup restored.'
