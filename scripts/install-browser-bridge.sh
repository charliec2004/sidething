#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"
# Run after loading browser-bridge unpacked in your Chromium browser.
# Argument is the exact browser profile parent containing NativeMessagingHosts.
if (( $# != 1 )); then
  print -u2 'Usage: ./scripts/install-browser-bridge.sh "/absolute/browser/profile-parent"'
  exit 1
fi
python3 - "$1" "${PWD}" <<'PY'
import json,sys
from pathlib import Path
profile=Path(sys.argv[1]);root=Path(sys.argv[2]);eid=(root/'browser-bridge/extension-id.txt').read_text().strip()
if not profile.is_absolute() or not profile.is_dir():raise SystemExit('Provide an existing absolute browser profile directory')
folder=profile/'NativeMessagingHosts';folder.mkdir(exist_ok=True)
dest=folder/'local.carthing.video.json';value={'name':'local.carthing.video','description':'Car Thing local video bridge','path':str(root/'CarThing.app/Contents/MacOS/CarThing'),'type':'stdio','allowed_origins':[f'chrome-extension://{eid}/']}
if dest.exists() and json.loads(dest.read_text())!=value:raise SystemExit('An existing host differs; it was not overwritten')
dest.write_text(json.dumps(value,indent=2));dest.chmod(0o600)
print('Registered the exact Car Thing extension origin.')
PY
