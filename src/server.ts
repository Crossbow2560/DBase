import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startUploadSessionCleanupWorker } from "./workers/upload-session-cleanup.js";
import { startDeletionQueueWorker } from "./workers/deletion-queue.js";
import { startThumbnailQueueWorker } from "./workers/thumbnail-queue.js";
import { startSyncEventsWorker } from "./workers/sync-events.js";

const app = await buildApp();

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// docs/decisions.md "Modular monolith, single instance": rate limits live in this process's memory
// and every instance runs the workers below — replicas are not supported. Said once at startup so
// it shows up wherever someone is looking at the logs while trying to scale this out.
app.log.info("Single-instance mode: in-memory rate limits and background workers run in this process; do not run replicas.");

startUploadSessionCleanupWorker();
startDeletionQueueWorker();
startThumbnailQueueWorker();
startSyncEventsWorker();
