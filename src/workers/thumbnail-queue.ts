// Same setInterval + in-memory overlap guard pattern as the other workers in this directory.

import { runThumbnailQueueTick } from "../modules/thumbnails/thumbnail-service.js";

const INTERVAL_MS = 30 * 1000; // more frequent than DELETION_QUEUE's drain — thumbnails are user-visible latency, not just cleanup

let tickInProgress = false;

export function startThumbnailQueueWorker(): NodeJS.Timeout {
  return setInterval(async () => {
    if (tickInProgress) return;
    tickInProgress = true;
    try {
      const { processed, failed } = await runThumbnailQueueTick();
      if (processed > 0 || failed > 0) {
        console.log(`[thumbnail-queue] processed ${processed} item(s), ${failed} permanently failed`);
      }
    } catch (err) {
      console.error("[thumbnail-queue] tick failed:", err);
    } finally {
      tickInProgress = false;
    }
  }, INTERVAL_MS);
}
