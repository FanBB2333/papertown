#!/bin/bash
# Builds Papertown.app into macos/build: the Swift binary, Info.plist (which remembers where this
# checkout is, so the app finds the server and the web code), the icon, an ad-hoc signature.
#   ./build.sh            build it
#   ./build.sh --install  and copy it to ~/Applications
# The page isn't inside the app: it is web/dist, served by the server, so changes to the web code
# don't need the app rebuilt. Only changes under macos/ do.
set -euo pipefail
cd "$(dirname "$0")"
repo=$(cd .. && pwd)
app=build/Papertown.app

swift build -c release --product Papertown
bin=$(swift build -c release --show-bin-path)/Papertown

rm -rf "$app" build/AppIcon.iconset
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/Papertown"
version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' ../web/package.json)
sed -e "s|@REPO@|$repo|" -e "s|@VERSION@|$version|" -e "s|@BUILD@|$(git rev-list --count HEAD 2>/dev/null || echo 1)|" \
  Resources/Info.plist > "$app/Contents/Info.plist"
cp ../web/public/logo.svg "$app/Contents/Resources/logo.svg"
swift Resources/icon.swift Resources/AppIcon.svg build/AppIcon.iconset
iconutil -c icns build/AppIcon.iconset -o "$app/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$app"
echo "built $app"

if [[ ${1:-} == --install ]]; then
  rm -rf ~/Applications/Papertown.app
  mkdir -p ~/Applications
  cp -R "$app" ~/Applications/
  echo "installed ~/Applications/Papertown.app"
fi
