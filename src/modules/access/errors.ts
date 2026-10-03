import { AppError } from "../accounts/errors.js";

export const insufficientPermission = () =>
  new AppError(403, "INSUFFICIENT_PERMISSION", "You don't have sufficient access to do this.");

export const itemNotFound = () => new AppError(404, "NOT_FOUND", "Item not found.");

export const shareLinkNotFound = () =>
  new AppError(404, "NOT_FOUND", "This link is invalid, expired, or no longer available.");

export const invalidSharePassword = () =>
  new AppError(401, "INVALID_PASSWORD", "Incorrect password.");

export const sharePasswordRequired = () =>
  new AppError(401, "PASSWORD_REQUIRED", "This link is password-protected.");
