import { AppError } from "../accounts/errors.js";

export const userNotFound = () => new AppError(404, "NOT_FOUND", "User not found.");

export const lastAdminStanding = () =>
  new AppError(409, "LAST_ADMIN", "This would leave zero admin accounts — at least one must always remain.");

// 409, not 500: this is an anticipated business-rule rejection (most commonly hit when the sole
// remaining admin tries to delete their own account — functionally the same last-admin-standing
// scenario as the DB trigger's LAST_ADMIN, just caught earlier here since reassignment has no
// valid target before delete_account() is even called), not a server malfunction.
export const noSystemAdmin = () =>
  new AppError(
    409,
    "NO_SYSTEM_ADMIN",
    "No other active admin account exists to receive this user's reassigned items — promote another admin first.",
  );
