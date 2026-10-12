#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { print -u2 'An Apple Silicon Mac is required.'; exit 1; }
xcode-select -p >/dev/null 2>&1 || { print -u2 'Install Apple command-line tools with: xcode-select --install'; exit 1; }
command -v brew >/dev/null || { print -u2 'Install Homebrew from https://brew.sh, then run this again.'; exit 1; }
[[ -x vendor/adb-arm64 ]] || { print -u2 'Bundled Google ADB is missing. Restore vendor/adb-arm64 from the repository.'; exit 1; }
brew list media-control >/dev/null 2>&1 || brew install ungive/media-control/media-control
./scripts/build.sh
python3 device/setup.py register
open CarThing.app
print 'Ready. The menu-bar helper reconnects automatically while running.'
