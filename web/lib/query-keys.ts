// FRONTEND_DESIGN.md §6.3: query key factories, plus which mutations invalidate which keys.
// Maintained by hand alongside each mutation — TanStack Query has no way to derive which
// server-side relationships a given mutation affects, so this list is the single place that
// knowledge lives, the same "no forgotten call site" discipline as lib/api-client.ts.

export const queryKeys = {
  me: () => ["auth", "me"] as const,
  sessions: () => ["auth", "sessions"] as const,
  storageUsage: () => ["users", "me", "storage"] as const,

  folderContents: (folderId: string | null) => ["folders", folderId, "contents"] as const,
  thumbnail: (fileId: string) => ["files", fileId, "thumbnail"] as const,
  search: (term: string) => ["search", term] as const,
  sharedWithMe: () => ["shared-with-me"] as const,
  favorites: () => ["favorites"] as const,
  trash: () => ["trash"] as const,

  adminUsers: () => ["admin", "users"] as const,
  adminUserFiles: (userId: string, folderId?: string) => ["admin", "users", userId, "files", folderId ?? null] as const,
  adminStats: () => ["admin", "stats"] as const,
  adminSystemStorage: () => ["admin", "system-storage"] as const,
  adminSystemStorageBreakdown: () => ["admin", "system-storage-breakdown"] as const,
  adminUserStorageBreakdown: (userId: string) => ["admin", "users", userId, "storage-breakdown"] as const,
  adminActivity: () => ["admin", "activity"] as const,
  adminFailedJobs: () => ["admin", "failed-jobs"] as const,
  adminBackups: () => ["admin", "backups"] as const,
} as const;

/**
 * Example of the pattern §6.3 requires: a move invalidates both the source and destination
 * folder-contents queries, not just the one the mutation was called from. Every future mutation
 * (share revoke, restore, tag apply, ...) should have an equivalent function here rather than
 * ad hoc invalidateQueries() calls scattered across components.
 */
export function invalidationsForMove(queryClient: { invalidateQueries: (opts: { queryKey: readonly unknown[] }) => void }, sourceFolderId: string | null, destinationFolderId: string | null) {
  queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(sourceFolderId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(destinationFolderId) });
}
