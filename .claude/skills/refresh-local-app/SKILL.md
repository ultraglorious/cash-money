---
name: refresh-local-app
description: Rebuild the desktop app and reinstall it to /Applications on macOS. Use when asked to update, refresh or reinstall the local app, or when a change needs checking in the real app rather than the browser preview.
---

# Refreshing the locally installed app

```bash
npm run app
```

From the repo root. Takes ~20 seconds incrementally, a minute or so from cold.

## What it does

`scripts/refresh-local-app.sh`:

1. Quits the running app **politely** (`osascript`, not `kill`) — it saves on a
   short debounce, so a hard kill can drop an unsaved edit.
2. Builds a **debug** bundle, skipping the `.dmg`. Debug reuses what dev builds
   already compiled: seconds instead of minutes, and for an app this size the
   runtime difference is invisible.
3. Copies it to `/Applications`.
4. Reopens it only if it was running before.

## Worth knowing

- Do **not** run this while `tauri dev` is open on the same budget file — both
  processes write to it. The three-way merge would cope, but there's no reason
  to make it.
- A locally built bundle carries no download quarantine, so macOS opens it
  without the Gatekeeper prompt an unsigned *download* would trigger.
- The browser preview (`npm run dev --workspace @cash-money/desktop`) is still
  the fast path for UI work — it hot-reloads and runs on demo data. Use this
  script when the change involves Tauri itself (file access, dialogs, the
  updater) or when you want to see it against the real budget.
- macOS only. The Windows machine takes the released installer instead.
