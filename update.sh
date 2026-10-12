#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
repo_url="$(git remote get-url origin)"
[[ "$repo_url" == https://github.com/charliec2004/sidething.git || "$repo_url" == git@github.com:charliec2004/sidething.git || "$repo_url" == https://github.com/charliec2004/sidething ]] || { print -u2 'Update requires the official SideThing origin.'; exit 1; }
[[ "$(git branch --show-current)" == main && -z "$(git status --porcelain)" ]] || { print -u2 'Commit or stash changes and switch to main before updating.'; exit 1; }
release_tag="$(curl --fail --silent --show-error --max-time 15 https://api.github.com/repos/charliec2004/sidething/releases/latest | python3 -c 'import json,re,sys; tag=json.load(sys.stdin)["tag_name"]; assert re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+",tag); print(tag)')"
git fetch origin "refs/tags/${release_tag}:refs/tags/${release_tag}"
git merge --ff-only "$release_tag"
previous_app="$(mktemp -d -t sidething-update)"
cp -R CarThing.app "$previous_app/CarThing.app"
if ! ./scripts/build.sh; then
  mv CarThing.app "$previous_app/failed-app"
  ditto "$previous_app/CarThing.app" CarThing.app
  print -u2 "Build failed. The previous app was restored; saved copy: $previous_app"
  exit 1
fi
python3 - "$PWD/CarThing.app/Contents/MacOS/CarThing" <<'PY'
import os,signal,subprocess,sys,time
binary=sys.argv[1]
for line in subprocess.check_output(['ps','-Ao','pid=,args=']).decode().splitlines():
 parts=line.strip().split(None,1)
 if len(parts)==2 and parts[1] in [binary,binary+' --open']:
  pid=int(parts[0]);os.kill(pid,signal.SIGTERM)
  for _ in range(50):
   try:os.kill(pid,0)
   except ProcessLookupError:break
   time.sleep(.1)
  else:raise SystemExit('The helper did not quit. Start the updated app after closing it.')
PY
open CarThing.app
print "SideThing $release_tag is running. Pairing and settings were retained."
