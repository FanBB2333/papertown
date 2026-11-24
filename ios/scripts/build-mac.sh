#!/bin/zsh
# Builds the native Mac app (the same SwiftUI code as the iPhone app) into ios/build/Papertown.app.
# It finds the Papertown checkout it was built from, so it can start this Mac's server on its own.
set -euo pipefail
cd ${0:a:h}/..
if [[ -z ${DEVELOPER_DIR:-} && $(xcode-select -p) == *CommandLineTools* ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer  # xcodebuild needs the full Xcode
fi
xcodebuild -project PapertownApp/Papertown.xcodeproj -scheme Papertown -configuration Release \
  -destination 'generic/platform=macOS' -derivedDataPath build/dd -quiet build
mkdir -p build
ditto build/dd/Build/Products/Release/Papertown.app build/Papertown.app
echo "built ${PWD}/build/Papertown.app"
