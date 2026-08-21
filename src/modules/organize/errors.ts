import { AppError } from "../accounts/errors.js";

export const itemNotFound = () => new AppError(404, "NOT_FOUND", "Item not found.");

export const tagNotFound = () => new AppError(404, "NOT_FOUND", "Tag not found.");

export const tagNameCollision = () =>
  new AppError(409, "NAME_COLLISION", "You already have a tag with this name.");
