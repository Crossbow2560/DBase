import { AppError } from "../accounts/errors.js";

export const itemNotFound = () => new AppError(404, "NOT_FOUND", "Item not found.");

export const notInTrash = () => new AppError(409, "NOT_IN_TRASH", "This item is not in the trash.");

export const purgeInFlight = () =>
  new AppError(409, "PURGE_IN_FLIGHT", "This item is already being permanently deleted and can no longer be restored.");
