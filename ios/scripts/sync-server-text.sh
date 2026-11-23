#!/bin/sh
# The app translates the Chinese text the server sends with the web's dictionary; copy it again after it changes.
set -e
cd "$(dirname "$0")/../.."
cp web/src/i18n/en.json ios/Sources/PapertownUI/Resources/server-en.json
echo "copied $(wc -l < ios/Sources/PapertownUI/Resources/server-en.json) lines"
