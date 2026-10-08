import { AppError } from "../accounts/errors.js";

export const userNotFound = () => new AppError(404, "NOT_FOUND", "User not found.");

export const invalidQuota = () =>
  new AppError(400, "VALIDATION_ERROR", "Quota must be a non-negative integer number of bytes.");

export const lastAdminStanding = () =>
  new AppError(409, "LAST_ADMIN", "This would leave zero admin accounts — at least one must always remain.");

export const invalidStorageLimit = () =>
  new AppError(400, "VALIDATION_ERROR", "Storage limit must be a non-negative integer number of bytes.");

export const invalidDefaultQuota = () =>
  new AppError(400, "VALIDATION_ERROR", "Default quota must be a non-negative integer number of bytes.");

export const defaultQuotaExceedsLimit = (limitBytes: bigint) =>
  new AppError(
    400,
    "VALIDATION_ERROR",
    `The default quota can't be larger than the ${formatGb(limitBytes)} GB system storage limit.`,
  );

export const backupNotFound = () =>
  new AppError(404, "NOT_FOUND", "That backup no longer exists — it may have been deleted directly in MinIO.");

// supabase/migrations/0022_preallocate_user_quotas.sql: quotas are pre-allocated out of the
// system-wide limit, so SUM(quotas) can never exceed it.
export const quotaExceedsUnallocated = (availableBytes: bigint) =>
  new AppError(
    409,
    "SYSTEM_STORAGE_ALLOCATION_EXCEEDED",
    `Not enough unallocated system storage for this quota — at most ${formatGb(availableBytes)} GB can be given to this user. Raise the system storage limit or lower other users' quotas first.`,
  );

export const storageLimitBelowAllocation = (allocatedBytes: bigint) =>
  new AppError(
    409,
    "STORAGE_LIMIT_BELOW_ALLOCATION",
    `The system limit can't be lower than the ${formatGb(allocatedBytes)} GB already allocated to user quotas. Lower user quotas first.`,
  );

function formatGb(bytes: bigint): string {
  return (Number(bytes) / 1e9).toFixed(2);
}
