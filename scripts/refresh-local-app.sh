#!/bin/sh
# Rebuild the desktop app and reinstall it to /Applications.
#
# `tauri dev` recompiles and starts a dev server on every launch, which is a
# lot of waiting when you only want to USE the app. This builds a bundle once
# and puts it where macOS can find it, so afterwards it opens from Spotlight
# like anything else. Run it again whenever you want the newest code.
#
# Debug rather than release: it reuses what dev builds already compiled, so it
# takes about a minute instead of several, and for an app this size the runtime
# difference is invisible.
set -e

case "$(uname -s)" in
  Darwin) ;;
  *) echo "This installs a macOS .app bundle; on Windows use the released installer." >&2; exit 1 ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
app="/Applications/cash-money.app"
built="$root/apps/desktop/src-tauri/target/debug/bundle/macos/cash-money.app"

# Ask it to quit rather than killing it: the app saves on a short debounce, and
# a hard kill could drop an edit that hasn't been written yet.
was_running=no
if pgrep -f "$app/Contents/MacOS" >/dev/null 2>&1; then
  was_running=yes
  echo "→ quitting the running app so it can finish saving"
  osascript -e 'quit app "cash-money"' >/dev/null 2>&1 || true
  sleep 2
fi

echo "→ building (about a minute)"
cd "$root/apps/desktop"
# --bundles app: skip the .dmg, which is only useful for shipping to someone.
npm run tauri build -- --debug --bundles app >/dev/null

echo "→ installing to $app"
rm -rf "$app"
cp -R "$built" /Applications/

if [ "$was_running" = yes ]; then
  echo "→ reopening"
  open -a "$app"
  echo "done — it was running, so it's back."
else
  echo "done — launch it from Spotlight, or: open -a $app"
fi
