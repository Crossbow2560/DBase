// The sync change log's housekeeping (supabase/migrations/0028): a frequent tick that sequences
// committed events, so a /sync read only ever has a handful left to sequence itself, and an
// hourly tick that prunes events past SYNC_EVENT_RETENTION_DAYS. Same setInterval + in-memory
// overlap guard pattern as src/workers/deletion-queue.ts.

import { config } from "../config.js";
import { pruneSyncEvents, sequenceEvents } from "../modules/sync/service.js";

const SEQUENCE_INTERVAL_MS = 10 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let sequenceInProgress = false;
let pruneInProgress = false;

export function startSyncEventsWorker(): { sequence: NodeJS.Timeout; prune: NodeJS.Timeout } {
  const sequence = setInterval(async () => {
    if (sequenceInProgress) return;
    sequenceInProgress = true;
    try {
      await sequenceEvents();
    } catch (err) {
      console.error("[sync-events] sequence tick failed:", err);
    } finally {
      sequenceInProgress = false;
    }
  }, SEQUENCE_INTERVAL_MS);

  const prune = setInterval(async () => {
    if (pruneInProgress) return;
    pruneInProgress = true;
    try {
      const count = await pruneSyncEvents(config.syncEventRetentionDays);
      if (count > 0) console.log(`[sync-events] pruned ${count} event(s) past the retention window`);
    } catch (err) {
      console.error("[sync-events] prune tick failed:", err);
    } finally {
      pruneInProgress = false;
    }
  }, PRUNE_INTERVAL_MS);

  return { sequence, prune };
}
