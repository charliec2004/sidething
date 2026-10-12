#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"
app="CarThing.app/Contents"
version="$(<VERSION)"
mkdir -p "$app/MacOS" "$app/Resources"
xcrun clang -fobjc-arc -c native/NightShift.m -o "$app/MacOS/nightshift.o"
xcrun swiftc -import-objc-header native/NightShift.h "$app/MacOS/nightshift.o" -O -swift-version 5 native/*.swift -o "$app/MacOS/CarThing" -framework AppKit -framework Network
rm "$app/MacOS/nightshift.o"
cp assets/AppIcon.icns "$app/Resources/AppIcon.icns"
cp public/* "$app/Resources/"
cp VERSION "$app/Resources/VERSION"
print -r -- "$PWD" > "$app/Resources/source-root.txt"
cp vendor/adb-arm64 "$app/Resources/adb"
cp vendor/ADB-NOTICE.txt "$app/Resources/adb-NOTICE.txt"
chmod 755 "$app/Resources/adb"
mkdir -p "$app/Resources/media-control"
chmod -R u+w "$app/Resources/media-control"
helper_prefix="$(brew --prefix media-control)"
cp -R "$helper_prefix/bin" "$helper_prefix/Frameworks" "$helper_prefix/lib" "$app/Resources/media-control/"
cat > "$app/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.carthing.companion</string><key>CFBundleExecutable</key><string>CarThing</string><key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundleName</key><string>SideThing</string><key>CFBundleShortVersionString</key><string>$version</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/><key>NSAppleEventsUsageDescription</key><string>Control Music playback, shuffle and repeat from your Car Thing.</string><key>NSLocationUsageDescription</key><string>Use your Mac’s location to fetch local weather from Open-Meteo.</string><key>NSLocationWhenInUseUsageDescription</key><string>Use your Mac’s location to fetch local weather from Open-Meteo.</string></dict></plist>
PLIST
codesign --force --sign - "CarThing.app" >/dev/null 2>&1
