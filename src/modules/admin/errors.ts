import { AppError } from "../accounts/errors.js";

export const userNotFound = () => new AppError(404, "NOT_FOUND", "User not found.");

export const invalidQuota = () =>
  new AppError(400, "VALIDATION_ERROR", "Quota must be a non-negative integer number of bytes.");

export const lastAdminStanding = () =>
  new AppError(409, "LAST_ADMIN", "This would leave zero admin accounts — at least one must always remain.");
