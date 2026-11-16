#!/bin/bash
# Builds macos/build/Papertown.app: the binary, an Info.plist recording this checkout's path, the icon, an ad-hoc signature.
#   ./build.sh            build it
#   ./build.sh --install  and copy it to ~/Applications
# web/dist isn't inside the app (the server serves it), so only changes under macos/ need a rebuild.
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
