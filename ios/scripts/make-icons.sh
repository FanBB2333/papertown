#!/bin/bash
# Draws the app icon into PapertownApp/Assets.xcassets/AppIcon.appiconset from macos/Resources/AppIcon.svg:
# the macOS sizes as they are, and for iOS the same sheet filling the square (iOS rounds the corners itself).
set -euo pipefail
cd "$(dirname "$0")/.."
svg=../macos/Resources/AppIcon.svg
set_=PapertownApp/Assets.xcassets/AppIcon.appiconset
tmp=$(mktemp -d)
trap 'mv "$tmp" ~/.Trash/papertown-icons-$(date +%Y%m%d-%H%M%S)' EXIT

python3 - "$svg" "$tmp/ios.svg" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
k = 1024 / 824  # the sheet is 824 wide from x=100; scale it to the whole square
s = re.sub(r'\s*<rect x="100" y="110"[^>]*/>', '', s)            # the shadow
s = re.sub(r'\s*<rect x="101.5"[^>]*/>', '', s)                  # the edge line
s = s.replace('<rect x="100" y="100" width="824" height="824" rx="185"', '<rect x="0" y="0" width="1024" height="1024"')
s = s.replace('translate(198 236) scale(9.5)', f'translate({(198-100)*k:.1f} {(236-100)*k:.1f}) scale({9.5*k:.3f})')
open(sys.argv[2], 'w').write(s)
PY
swift ../macos/Resources/icon.swift "$svg" "$tmp/mac.iconset" >/dev/null
swift ../macos/Resources/icon.swift "$tmp/ios.svg" "$tmp/ios.iconset" >/dev/null

find "$set_" -name '*.png' -exec mv {} "$tmp/" \;
cp "$tmp/ios.iconset/icon_512x512@2x.png" "$set_/ios-1024.png"
for f in "$tmp"/mac.iconset/*.png; do cp "$f" "$set_/mac-$(basename "$f")"; done
python3 - "$set_" <<'PY'
import json, sys
images = [{"filename": "ios-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}]
for pt in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        name = f"mac-icon_{pt}x{pt}{'@2x' if scale == 2 else ''}.png"
        images.append({"filename": name, "idiom": "mac", "scale": f"{scale}x", "size": f"{pt}x{pt}"})
json.dump({"images": images, "info": {"author": "xcode", "version": 1}}, open(f"{sys.argv[1]}/Contents.json", "w"), indent=2)
PY
echo "icons written to $set_"
