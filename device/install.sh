#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"
source device/common.sh
python3 device/setup.py backup
python3 device/branding.py prepare
[[ "$($adb_bin -s "$serial" shell uname -m | tr -d '\r')" == 'aarch64' ]] || { print -u2 'Expected Superbird is not connected.'; exit 1; }
temp_config="$(mktemp)"
trap 'rm -f "$temp_config"' EXIT
python3 - "$backup/supervisord.conf" "$temp_config" <<'PY'
import configparser,sys
c=configparser.ConfigParser(interpolation=None);c.read(sys.argv[1])
old='--app=file:///usr/share/qt-superbird-app/webapp/index.html'
assert old in c['program:chromium']['command'], 'Unexpected original startup configuration'
c['program:chromium']['command']=c['program:chromium']['command'].replace(old,'--app=file:///var/carthing/boot.html')
c['program:chromium']['command']=c['program:chromium']['command'].replace('/var/cache/chrome_storage','/var/cache/sidething')
for name in ['superbird','swupdate','backlight']:
 c['program:'+name]['autostart']='false';c['program:'+name]['autorestart']='false'
with open(sys.argv[2],'w') as f:c.write(f)
PY
"$adb_bin" -s "$serial" shell 'mkdir -p /var/carthing; chmod 755 /var/carthing'
"$adb_bin" -s "$serial" push device/boot.html /var/carthing/boot.html
"$adb_bin" -s "$serial" push "$temp_config" /var/carthing/supervisord.new.conf
"$adb_bin" -s "$serial" shell 'set -e; mount -o remount,rw /; trap "mount -o remount,ro /" EXIT; cp /var/carthing/supervisord.new.conf /etc/supervisord.carthing.new && chmod 644 /etc/supervisord.carthing.new && mv /etc/supervisord.carthing.new /etc/supervisord.conf && sync'
python3 device/branding.py install
"$adb_bin" -s "$serial" shell 'supervisorctl reread && supervisorctl update'
print 'Own startup installed. Restart the Mac companion to pair the device display.'
