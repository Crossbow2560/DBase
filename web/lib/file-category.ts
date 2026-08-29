// Shared between folder-browser.tsx's type filter and the public share-link page's — "Files" is
// the catch-all for everything that isn't image/video/audio (documents, archives, code, anything
// with no more specific mime prefix), matching the wording of both pages' filter dropdowns rather
// than calling it "documents", since plenty of files in here won't be.
export type FileCategory = "image" | "video" | "audio" | "document";

export function fileCategory(mimeType: string | undefined): FileCategory {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  return "document";
}
