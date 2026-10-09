import { AppError } from "../accounts/errors.js";

// REQUIREMENTS.md §5.12: distinct, specific error codes per failure reason — matches the
// pattern already established in accounts/errors.ts.

export const nameCollision = () =>
  new AppError(409, "NAME_COLLISION", "An item with this name already exists here.");

export const nameTooLong = () =>
  new AppError(400, "NAME_TOO_LONG", "Names must be at most 255 bytes (UTF-8).");

export const pathTooLong = () =>
  new AppError(400, "PATH_TOO_LONG", "The full path would exceed 4096 bytes (UTF-8).");

export const cycleDetected = () =>
  new AppError(409, "CYCLE_DETECTED", "Cannot move a folder into itself or one of its own subfolders.");

export const folderNotFound = () => new AppError(404, "NOT_FOUND", "Folder not found.");

export const fileNotFound = () => new AppError(404, "NOT_FOUND", "File not found.");

export const notAFolder = () => new AppError(400, "NOT_A_FOLDER", "Target is not a folder.");

export const quotaExceeded = () =>
  new AppError(422, "QUOTA_EXCEEDED", "This upload would exceed your storage quota.");

// Distinct from quotaExceeded() (REQUIREMENTS.md §5.12: specific codes per failure reason) —
// this is the whole system's shared cap being full, not this account's own quota, and the
// frontend should say so rather than implying the user's personal quota is at fault.
export const systemStorageLimitExceeded = () =>
  new AppError(
    422,
    "SYSTEM_STORAGE_LIMIT_EXCEEDED",
    "This upload would exceed the system's total storage limit. Contact an admin.",
  );

export const uploadSessionNotFound = () =>
  new AppError(404, "UPLOAD_SESSION_NOT_FOUND", "Upload session not found or already finished.");

export const uploadSessionInvalid = () =>
  new AppError(409, "UPLOAD_SESSION_INVALID", "This upload's destination is no longer valid.");

export const partNumberOutOfRange = (totalParts: number) =>
  new AppError(400, "VALIDATION_ERROR", `Part number must be between 0 and ${totalParts - 1}.`);

export const partTooSmall = (minBytes: number) =>
  new AppError(
    400,
    "PART_TOO_SMALL",
    `Every part except the last must be at least ${minBytes} bytes.`,
  );

export const partTooLarge = (maxBytes: number) =>
  new AppError(413, "PART_TOO_LARGE", `A single part may be at most ${maxBytes} bytes.`);

export const lengthRequired = () =>
  new AppError(411, "LENGTH_REQUIRED", "Upload parts must be sent with a Content-Length header.");

export const uploadCompleting = () =>
  new AppError(409, "UPLOAD_IN_PROGRESS", "This upload is still being finalized. Try again in a moment.");

export const uploadIncomplete = () =>
  new AppError(409, "UPLOAD_SESSION_INVALID", "Not every part of this upload has been received yet.");

export const invalidFolderTree = (message: string) => new AppError(400, "VALIDATION_ERROR", message);

export const noLongerAvailable = () =>
  new AppError(404, "NO_LONGER_AVAILABLE", "This file is no longer available.");

// Replacing a file's content (upload-service.ts completeReplace): the file changed (or was
// trashed) since the client last saw it, so its upload would overwrite an edit it never saw.
export const contentConflict = () =>
  new AppError(409, "CONTENT_CONFLICT", "The file changed or was deleted since you last synced it.");
