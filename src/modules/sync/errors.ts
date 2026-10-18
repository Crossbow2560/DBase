import { AppError } from "../accounts/errors.js";

// Deliberately one error for "doesn't exist", "trashed" and "no access" — same non-disclosure
// convention as the rest of the API (folderNotFound for a folder you can't see).
export const syncRootUnavailable = () =>
  new AppError(404, "SYNC_ROOT_UNAVAILABLE", "The sync root folder doesn't exist, is in the trash, or you no longer have access to it.");

export const cursorExpired = () =>
  new AppError(410, "CURSOR_EXPIRED", "This cursor is older than the change log's retention. Re-read /sync/tree and resume from its cursor.");

export const invalidCursor = () => new AppError(400, "VALIDATION_ERROR", "cursor must be a non-negative integer.");
