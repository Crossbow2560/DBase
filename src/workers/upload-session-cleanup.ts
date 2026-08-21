// APPLICATION_DESIGN.md §7.6: time-triggered, not event-triggered — a setInterval tick scanning
// for status='pending' AND expires_at < now(), performing the abort-and-credit-back procedure
// directly. No separate queue table for this (DESIGN.md models it as a direct state transition
// on UPLOAD_SESSIONS itself).

import { cleanupExpiredSessions } from "../modules/filesystem/upload-service.js";

const INTERVAL_MS = 5 * 60 * 1000; // APPLICATION_DESIGN.md §7.7's suggested default for this worker

let tickInProgress = false; // §7.3: in-memory guard against overlapping ticks in this process

export function startUploadSessionCleanupWorker(): NodeJS.Timeout {
  return setInterval(async () => {
    if (tickInProgress) return;
    tickInProgress = true;
    try {
      const count = await cleanupExpiredSessions();
      if (count > 0) {
        console.log(`[upload-session-cleanup] aborted ${count} expired session(s)`);
      }
    } catch (err) {
      console.error("[upload-session-cleanup] tick failed:", err);
    } finally {
      tickInProgress = false;
    }
  }, INTERVAL_MS);
}
