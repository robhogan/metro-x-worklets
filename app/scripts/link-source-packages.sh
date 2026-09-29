#!/usr/bin/env bash
#
# Point this app's node_modules at the sibling source checkouts:
#   - every metro-* package -> ../metro/packages/<name>
#   - react-native-worklets and react-native-reanimated -> the reanimated monorepo
#
# Rerun after any `npm install`, which restores the published copies.

set -euo pipefail

APP_ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
METRO_ROOT=$(cd "$APP_ROOT/../metro" && pwd -P)
REANIMATED_ROOT=$(cd "$APP_ROOT/../react-native-reanimated" && pwd -P)

link() {
  local target=$1 name=$2
  local dest="$APP_ROOT/node_modules/$name"
  rm -rf "$dest"
  ln -s "$target" "$dest"
  echo "linked $name -> $target"
}

for pkg_dir in "$METRO_ROOT"/packages/*/; do
  name=$(node -p "require('$pkg_dir/package.json').name")
  case "$name" in
    metro|metro-*) link "$pkg_dir" "$name" ;;
  esac
done

link "$REANIMATED_ROOT/packages/react-native-worklets" react-native-worklets
link "$REANIMATED_ROOT/packages/react-native-reanimated" react-native-reanimated

# Nested copies would shadow the links. Only unscoped `metro` / `metro-*`
# directories directly inside a nested node_modules count; scoped packages such
# as @react-native/metro-config are left alone.
find "$APP_ROOT/node_modules" -mindepth 3 -type d -regex '.*/node_modules/metro\(-[^/]*\)?' 2>/dev/null | while read -r nested; do
  echo "removing nested copy $nested"
  rm -rf "$nested"
done
