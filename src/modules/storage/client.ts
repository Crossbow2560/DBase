import { Client as MinioClient, CopySourceOptions, CopyDestinationOptions } from "minio";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { config } from "../../config.js";

// APPLICATION_DESIGN.md §1.3/§3.2: the ONLY module permitted to construct or dereference a
// storage_key/thumbnail_key against the object store — every other module goes through the
// functions exported here, never touches the MinIO client directly.

// region is pinned explicitly on both clients below: without it, the minio SDK's
// presignedGetObject makes a REAL network call to look up the bucket's region before it can
// sign anything (getBucketRegion) — this is not, as first assumed, a pure local computation.
// That call would fail outright for publicClient below, which has no real connectivity to its
// own "public" endpoint from inside this container (found as a live ECONNREFUSED 127.0.0.1:9000
// while actually loading a thumbnail in a browser). Pinning the region short-circuits that
// lookup entirely, so presigning becomes the pure local signature computation it needs to be.
const REGION = "us-east-1";

const client = new MinioClient({
  endPoint: config.minio.endpoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
  region: REGION,
});

// Used ONLY to build presigned URLs (see config.ts's minio.publicEndpoint comment) — the host
// baked into a presigned URL's signature must be the host the browser will actually send the
// request to, which is this deployment's public-facing MinIO address, not the Docker-internal
// one `client` above uses to actually talk to MinIO.
const publicClient = new MinioClient({
  endPoint: config.minio.publicEndpoint,
  port: config.minio.publicPort,
  useSSL: config.minio.publicUseSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
  region: REGION,
});

const BUCKET = config.minio.bucket;

// DESIGN.md §3.4: storage_key must be non-guessable — a random UUID or content-hash-derived
// key, never a predictable pattern like {folder_id}/{filename}.
export function generateStorageKey(): string {
  return `files/${randomBytes(32).toString("hex")}`;
}

// Same non-guessability requirement as storage_key (DESIGN.md §3.4/§3.13).
export function generateThumbnailKey(): string {
  return `thumbnails/${randomBytes(32).toString("hex")}`;
}

function tempPartKey(uploadSessionId: string, partNumber: number): string {
  return `tmp/${uploadSessionId}/part-${String(partNumber).padStart(6, "0")}`;
}

export async function ensureBucketExists(): Promise<void> {
  const exists = await client.bucketExists(BUCKET).catch(() => false);
  if (!exists) {
    await client.makeBucket(BUCKET);
  }
}

export async function putPart(uploadSessionId: string, partNumber: number, data: Buffer): Promise<void> {
  await client.putObject(BUCKET, tempPartKey(uploadSessionId, partNumber), data);
}

/**
 * Composes every uploaded part (in part-number order) into one final object at storageKey, via
 * MinIO's server-side compose (no re-upload of bytes through this process), then removes the
 * temporary per-part objects. Requires at least one part — MinIO's composeObject rejects an
 * empty source list.
 */
export async function completeMultipartUpload(
  uploadSessionId: string,
  totalParts: number,
  storageKey: string,
): Promise<void> {
  const sources = Array.from({ length: totalParts }, (_, i) =>
    new CopySourceOptions({ Bucket: BUCKET, Object: tempPartKey(uploadSessionId, i) }),
  );
  const destination = new CopyDestinationOptions({ Bucket: BUCKET, Object: storageKey });
  await client.composeObject(destination, sources);
  await removeUploadParts(uploadSessionId, totalParts);
}

export async function removeUploadParts(uploadSessionId: string, totalParts: number): Promise<void> {
  const keys = Array.from({ length: totalParts }, (_, i) => tempPartKey(uploadSessionId, i));
  await client.removeObjects(BUCKET, keys).catch(() => undefined);
}

/**
 * Deliberately does NOT swallow errors, unlike removeUploadParts above — this is the primary
 * call the DELETION_QUEUE worker (src/modules/trash/deletion-queue-service.ts) makes, and
 * DESIGN.md §3.10's retry policy depends on a transient failure here actually surfacing so the
 * worker can leave the row `pending` and retry, rather than silently proceeding to purge the DB
 * row and credit quota back for a blob that was never actually removed. S3-compatible deletes
 * are idempotent — removing an already-gone key is not itself an error — so no special
 * not-found handling is needed for the worker's own retry-after-partial-success case.
 */
export async function removeObject(storageKey: string): Promise<void> {
  await client.removeObject(BUCKET, storageKey);
}

/**
 * `downloadFilename`, when given, sets a response-content-disposition override so the browser
 * saves the file under its real name instead of the raw storage_key — found as a real bug
 * (downloads landing in the filesystem as an unreadable hex hash with no extension) by actually
 * clicking Download in a browser rather than only checking the response status.
 */
export async function getPresignedDownloadUrl(
  storageKey: string,
  expirySeconds = 300,
  downloadFilename?: string,
): Promise<string> {
  const respHeaders = downloadFilename
    ? { "response-content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadFilename)}` }
    : undefined;
  return publicClient.presignedGetObject(BUCKET, storageKey, expirySeconds, respHeaders);
}

/**
 * For in-browser preview (an <img>/<video>/<iframe> src), as opposed to getPresignedDownloadUrl
 * above — deliberately `inline`, not `attachment`: the same disposition override that makes a
 * download save under the right filename would, on a preview element, make the browser refuse to
 * render the content at all and pop a save dialog instead. Also overrides content-type: the
 * object's actual stored Content-Type is always generic (composeObject, used to assemble
 * multipart uploads, never sets one — upload-service.ts), so without this override every preview
 * would arrive as application/octet-stream and most browsers won't inline-render that regardless
 * of file extension.
 */
export async function getPresignedPreviewUrl(
  storageKey: string,
  mimeType: string,
  expirySeconds = 300,
): Promise<string> {
  const respHeaders = {
    "response-content-disposition": "inline",
    "response-content-type": mimeType,
  };
  return publicClient.presignedGetObject(BUCKET, storageKey, expirySeconds, respHeaders);
}

/** Downloads an object's full bytes — used by the thumbnail worker to read the source file. */
export async function getObjectBuffer(storageKey: string): Promise<Buffer> {
  const stream = await client.getObject(BUCKET, storageKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * The raw object stream, not buffered — used by the folder-zip download (filesystem module) so
 * building a zip of a folder full of large files doesn't hold every one of them fully in memory
 * at once; each file streams straight from MinIO into the zip archive as it's added.
 */
export async function getObjectStream(storageKey: string): Promise<Readable> {
  return client.getObject(BUCKET, storageKey);
}

export async function putThumbnail(thumbnailKey: string, data: Buffer): Promise<void> {
  await client.putObject(BUCKET, thumbnailKey, data, undefined, { "Content-Type": "image/jpeg" });
}

/**
 * Admin-triggered backup (admin/backup-service.ts): duplicates every object currently in BUCKET
 * into a fresh, timestamped bucket via MinIO's server-side copy (same composeObject-style
 * CopySourceOptions/CopyDestinationOptions used above) — bytes never round-trip through this
 * process, so this stays cheap regardless of how large the store gets. Each run gets its own
 * bucket rather than overwriting a single "backup" target, so an admin can keep more than one
 * snapshot and a bad backup run can't clobber a previously-good one.
 */
const BACKUP_BUCKET_PREFIX = `${BUCKET}-backup-`;

export async function backupBucket(): Promise<{ backupBucket: string; objectCount: number }> {
  // Bucket names must be lowercase and may only contain letters, digits, and hyphens — an ISO
  // timestamp's colons and the fractional-second dot both violate that.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").toLowerCase();
  const backupBucketName = `${BACKUP_BUCKET_PREFIX}${timestamp}`;
  await client.makeBucket(backupBucketName);

  let objectCount = 0;
  for await (const item of client.listObjectsV2(BUCKET, "", true)) {
    if (!item.name) continue;
    await client.copyObject(
      new CopySourceOptions({ Bucket: BUCKET, Object: item.name }),
      new CopyDestinationOptions({ Bucket: backupBucketName, Object: item.name }),
    );
    objectCount++;
  }

  return { backupBucket: backupBucketName, objectCount };
}

/**
 * Every bucket backupBucket() above has ever produced, newest first — the admin restore UI's
 * picklist. Filtered to the `${BUCKET}-backup-` prefix rather than returning every bucket in the
 * account so an unrelated bucket some other process created on the same MinIO instance can never
 * show up as a "restore" candidate.
 */
export async function listBackupBuckets(): Promise<{ name: string; createdAt: Date }[]> {
  const buckets = await client.listBuckets();
  return buckets
    .filter((b) => b.name.startsWith(BACKUP_BUCKET_PREFIX))
    .map((b) => ({ name: b.name, createdAt: b.creationDate }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Copies every object from a previously-made backup bucket back into the live BUCKET, overwriting
 * whatever currently sits at each key. Deliberately does NOT delete anything from BUCKET that
 * isn't present in the backup — every storage_key in this app is an opaque random name
 * (generateStorageKey/generateThumbnailKey above), so restoring is "put back these exact bytes at
 * these exact keys," not "make BUCKET's key set match the backup's," and a file created after the
 * backup was taken has no reason to disappear just because an older snapshot is being restored.
 *
 * `backupBucketName` MUST be validated by the caller against listBackupBuckets()'s own output
 * (admin/backup-service.ts) before this is called — this only re-checks the prefix as a last-
 * resort guard, not the primary defense, since accepting an arbitrary caller-supplied bucket name
 * here would let a restore read from any bucket this MinIO credential can see.
 */
export async function restoreBucket(backupBucketName: string): Promise<{ objectCount: number }> {
  if (!backupBucketName.startsWith(BACKUP_BUCKET_PREFIX)) {
    throw new Error(`Refusing to restore from non-backup bucket "${backupBucketName}".`);
  }
  const exists = await client.bucketExists(backupBucketName);
  if (!exists) {
    throw new Error(`Backup bucket "${backupBucketName}" does not exist.`);
  }

  let objectCount = 0;
  for await (const item of client.listObjectsV2(backupBucketName, "", true)) {
    if (!item.name) continue;
    await client.copyObject(
      new CopySourceOptions({ Bucket: backupBucketName, Object: item.name }),
      new CopyDestinationOptions({ Bucket: BUCKET, Object: item.name }),
    );
    objectCount++;
  }

  return { objectCount };
}
