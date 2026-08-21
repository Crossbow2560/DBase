// DESIGN.md §3.10/§5.2: two independent timers sharing one module — a frequent tick draining
// pending DELETION_QUEUE rows (so a "delete forever" request is actually purged promptly), and
// a much less frequent tick that scans FILES/FOLDERS for anything that's aged past the 30-day
// retention window and enqueues it. Same setInterval + in-memory overlap guard pattern as
// src/workers/upload-session-cleanup.ts, one guard per timer since the two ticks are independent
// of each other.

import { runDeletionQueueTick, scanAndEnqueueExpired } from "../modules/trash/deletion-queue-service.js";

const DRAIN_INTERVAL_MS = 60 * 1000; // process pending rows roughly every minute
const SCAN_INTERVAL_MS = 60 * 60 * 1000; // 30-day expiry only needs day-granularity freshness

let drainInProgress = false;
let scanInProgress = false;

export function startDeletionQueueWorker(): { drain: NodeJS.Timeout; scan: NodeJS.Timeout } {
  const drain = setInterval(async () => {
    if (drainInProgress) return;
    drainInProgress = true;
    try {
      const { processed, failed } = await runDeletionQueueTick();
      if (processed > 0 || failed > 0) {
        console.log(`[deletion-queue] processed ${processed} item(s), ${failed} permanently failed`);
      }
    } catch (err) {
      console.error("[deletion-queue] drain tick failed:", err);
    } finally {
      drainInProgress = false;
    }
  }, DRAIN_INTERVAL_MS);

  const scan = setInterval(async () => {
    if (scanInProgress) return;
    scanInProgress = true;
    try {
      const count = await scanAndEnqueueExpired();
      if (count > 0) {
        console.log(`[deletion-queue] enqueued ${count} item(s) past the retention window`);
      }
    } catch (err) {
      console.error("[deletion-queue] scan tick failed:", err);
    } finally {
      scanInProgress = false;
    }
  }, SCAN_INTERVAL_MS);

  return { drain, scan };
}
