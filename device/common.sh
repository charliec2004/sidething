# Shared by install/restore; device registration is the source of truth.
adb_bin="${CARTHING_ADB_BIN:-${PWD}/CarThing.app/Contents/Resources/adb}"
data_dir="${CARTHING_DATA_DIR:-${HOME}/Library/Application Support/CarThing}"
serial="$(python3 - "$data_dir/device.json" <<'PY'
import json,re,sys
from pathlib import Path
p=Path(sys.argv[1])
if not p.exists(): raise SystemExit('Run ./setup.sh first to register a Car Thing.')
s=json.loads(p.read_text()).get('serial','')
if not re.fullmatch(r'[A-Za-z0-9]{6,40}',s): raise SystemExit('Invalid registered device.')
print(s)
PY
)"
backup="${CARTHING_BACKUP_DIR:-${data_dir}/backups/${serial}}"
