// In-app updates, deliberately quiet.
//
// One check shortly after the budget loads — never a poll. Finding an update
// shows a notification with a single "Restart & update" button; nothing
// downloads until it's clicked. Installing FLUSHES SAVES FIRST: on Windows the
// installer exits the app the moment it starts, so the flush cannot wait until
// afterwards. `relaunch` is a no-op there (the passive installer restarts the
// app itself) but completes the flow on any platform that returns.
//
// Every failure path is silent by design: a machine without a release for its
// platform (the Mac uses `npm run app`), an offline launch, or a malformed
// response should never interrupt budgeting. The signature check is the
// updater plugin's own — an artifact that doesn't verify against the public
// key in tauri.conf.json is refused before it ever runs.
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface AvailableUpdate {
  version: string;
  /** Download, install and restart. `flushSaves` runs to completion first. */
  install: (flushSaves: () => Promise<void>) => Promise<void>;
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  try {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      install: async (flushSaves) => {
        await flushSaves();
        await update.downloadAndInstall();
        await relaunch();
      },
    };
  } catch {
    return null;
  }
}
