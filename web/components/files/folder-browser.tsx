"use client";

// Backs both /folders (root, folderId = null) and /folders/[folderId]. Calls the filesystem
// endpoints APPLICATION_DESIGN.md §4.3 documents — GET .../contents, POST /folders, DELETE
// /folders/:id, DELETE /files/:id, all implemented (Subcomponent 1). Rename isn't wired into
// this UI yet — this is still a minimal slice of the folder browser, not the full page.

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useUploads } from "@/lib/uploads";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { ShareModal } from "@/components/files/share-modal";
import { RenameModal } from "@/components/files/rename-modal";
import { MoveModal } from "@/components/files/move-modal";
import { TagsModal } from "@/components/files/tags-modal";

interface FolderContentsItem {
  id: string;
  name: string;
  type: "file" | "folder";
}

interface CurrentFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
}

/**
 * REQUIREMENTS.md §5.9: "no preview available" is a normal state, not an error — this just falls
 * back to the plain file icon whenever the endpoint reports unavailable (not thumbnailable,
 * still generating, or failed), same as while loading.
 */
function FileThumbnail({ fileId }: { fileId: string }) {
  const { data } = useQuery({
    queryKey: queryKeys.thumbnail(fileId),
    queryFn: () => api.get<{ available: boolean; url?: string }>(`/files/${fileId}/thumbnail`),
    staleTime: 60_000,
  });

  if (data?.available && data.url) {
    return <img src={data.url} alt="" className="h-8 w-8 rounded object-cover" />;
  }
  return <span>📄</span>;
}

export function FolderBrowser({ folderId }: { folderId: string | null }) {
  const queryClient = useQueryClient();
  const { startUpload } = useUploads();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [newFolderName, setNewFolderName] = React.useState("");
  const [previewItem, setPreviewItem] = React.useState<FolderContentsItem | null>(null);
  const [shareItem, setShareItem] = React.useState<FolderContentsItem | null>(null);
  const [renameItem, setRenameItem] = React.useState<FolderContentsItem | null>(null);
  const [moveItem, setMoveItem] = React.useState<FolderContentsItem | null>(null);
  const [tagsItem, setTagsItem] = React.useState<FolderContentsItem | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.folderContents(folderId),
    queryFn: () =>
      api.get<{ folder: CurrentFolder | null; items: FolderContentsItem[] }>(
        folderId ? `/folders/${folderId}/contents` : "/folders/contents",
      ),
  });

  // Bulk-fetched once rather than a per-row query (same N+1 concern the thumbnail component
  // above already accepts per-row for a different reason) — favorites list is small and this
  // lets every row's star reflect real state instead of only ever offering "add".
  const { data: favoritesData } = useQuery({
    queryKey: queryKeys.favorites(),
    queryFn: () => api.get<{ items: { id: string }[] }>("/favorites"),
  });
  const favoritedIds = new Set(favoritesData?.items.map((f) => f.id));

  async function toggleFavorite(item: FolderContentsItem) {
    if (favoritedIds.has(item.id)) {
      await api.delete(`/items/${item.type}/${item.id}/favorite`);
    } else {
      await api.post(`/items/${item.type}/${item.id}/favorite`);
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.favorites() });
  }

  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    await api.post("/folders", { name: newFolderName, parentFolderId: folderId });
    setNewFolderName("");
    queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(folderId) });
  }

  async function deleteItem(item: FolderContentsItem) {
    await api.delete(item.type === "folder" ? `/folders/${item.id}` : `/files/${item.id}`);
    queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(folderId) });
  }

  async function downloadFile(item: FolderContentsItem) {
    // Opened synchronously, before the await below — a window.open() called only after an async
    // gap no longer counts as a direct result of the click to most browsers' popup blockers and
    // gets silently swallowed (found by actually clicking Download and seeing nothing happen).
    const tab = window.open("", "_blank");
    const { url } = await api.get<{ url: string }>(`/files/${item.id}/download`);
    if (tab) tab.location.href = url;
  }

  function onFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      startUpload(file, folderId);
    }
    e.target.value = "";
  }

  return (
    <div className="space-y-4">
      {data?.folder && (
        <Link
          href={data.folder.parentFolderId ? `/folders/${data.folder.parentFolderId}` : "/folders"}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back
        </Link>
      )}

      <div className="flex gap-2">
        <form onSubmit={createFolder} className="flex gap-2">
          <Input
            placeholder="New folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            className="max-w-xs"
          />
          <Button type="submit">New folder</Button>
        </form>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFilesSelected} />
        <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
          Upload files
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p className="text-sm text-destructive">
          {error instanceof ApiError ? error.message : "Could not load this folder."}
        </p>
      )}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">This folder is empty.</p>}

      <ul className="divide-y divide-border rounded-md border border-border">
        {data?.items.map((item) => (
          <li key={item.id} className="flex items-center justify-between px-3 py-2 text-sm">
            {item.type === "folder" ? (
              <Link href={`/folders/${item.id}`} className="hover:underline">
                📁 {item.name}
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => setPreviewItem(item)}
                className="flex items-center gap-2 hover:underline"
              >
                <FileThumbnail fileId={item.id} />
                {item.name}
              </button>
            )}
            <div className="flex flex-wrap gap-1">
              <Button variant="ghost" size="sm" onClick={() => toggleFavorite(item)}>
                {favoritedIds.has(item.id) ? "★" : "☆"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRenameItem(item)}>
                Rename
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMoveItem(item)}>
                Move
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setTagsItem(item)}>
                Tags
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShareItem(item)}>
                Share
              </Button>
              {item.type === "file" && (
                <Button variant="ghost" size="sm" onClick={() => downloadFile(item)}>
                  Download
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => deleteItem(item)}>
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {previewItem && (
        <FilePreviewModal
          fileId={previewItem.id}
          name={previewItem.name}
          onClose={() => setPreviewItem(null)}
        />
      )}

      {shareItem && (
        <ShareModal
          itemType={shareItem.type}
          itemId={shareItem.id}
          itemName={shareItem.name}
          onClose={() => setShareItem(null)}
        />
      )}

      {renameItem && (
        <RenameModal
          itemType={renameItem.type}
          itemId={renameItem.id}
          currentName={renameItem.name}
          onClose={() => setRenameItem(null)}
          onRenamed={() => queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(folderId) })}
        />
      )}

      {moveItem && (
        <MoveModal
          itemType={moveItem.type}
          itemId={moveItem.id}
          itemName={moveItem.name}
          onClose={() => setMoveItem(null)}
          onMoved={() => queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(folderId) })}
        />
      )}

      {tagsItem && (
        <TagsModal
          itemType={tagsItem.type}
          itemId={tagsItem.id}
          itemName={tagsItem.name}
          onClose={() => setTagsItem(null)}
        />
      )}
    </div>
  );
}
