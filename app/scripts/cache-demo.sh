#!/usr/bin/env bash
#
# Shows that worklet modules ride Metro's transform cache correctly:
#   1. cold build
#   2. warm rebuild: no new cache entries
#   3. edit App.tsx outside any worklet: exactly one new entry (App.tsx itself);
#      every worklet module keeps its id and hits the cache
#   4. edit a worklet body: two new entries (App.tsx and the changed worklet's
#      new module); the untouched worklets still hit the cache

set -euo pipefail
cd "$(dirname "$0")/.."

BUILD="node -r ./scripts/metro-source-register.js ../metro/packages/metro/src/cli.js build index.js --platform ios --dev true --config metro.config.js --out dist/ios.dev.js"
count() { find .metro-cache -type f 2>/dev/null | wc -l | tr -d ' '; }
virtuals() { grep -o '"[^"]*App\.tsx?virtual=[0-9a-f]*"' dist/ios.dev.js | sort -u; }

cp App.tsx /tmp/App.tsx.orig
trap 'cp /tmp/App.tsx.orig App.tsx' EXIT

rm -rf .metro-cache
$BUILD --reset-cache >/dev/null 2>&1
cold=$(count); echo "cold build:                    $cold cache entries"
virtuals > /tmp/virtuals.cold

$BUILD >/dev/null 2>&1
warm=$(count); echo "warm rebuild:                  +$((warm - cold))"

sed -i '' 's/Worklets Bundle Mode × Metro/Worklets Bundle Mode x Metro (edited)/' App.tsx
$BUILD >/dev/null 2>&1
edit1=$(count); echo "edit App.tsx outside worklets: +$((edit1 - warm))"
virtuals > /tmp/virtuals.edit1
if diff -q /tmp/virtuals.cold /tmp/virtuals.edit1 >/dev/null; then
  echo "  worklet module ids unchanged: yes ($(wc -l < /tmp/virtuals.cold | tr -d ' ') modules)"
else
  echo "  worklet module ids unchanged: NO"; diff /tmp/virtuals.cold /tmp/virtuals.edit1
fi

sed -i '' 's/const rounded = Math.round(offset.value);/const rounded = Math.round(offset.value * 1);/' App.tsx
$BUILD >/dev/null 2>&1
edit2=$(count); echo "edit one worklet body:         +$((edit2 - edit1))"
virtuals > /tmp/virtuals.edit2
echo "  worklet module ids changed:   $(comm -13 /tmp/virtuals.edit1 /tmp/virtuals.edit2 | wc -l | tr -d ' ') of $(wc -l < /tmp/virtuals.edit2 | tr -d ' ')"
