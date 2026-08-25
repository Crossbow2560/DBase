"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, FileText, Star, List, LayoutGrid, Pencil, FolderInput, Tags, Share2, Download, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { formatBytes, formatDate } from "@/lib/format";
import { useViewPreference } from "@/lib/use-view-preference";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { ShareModal } from "@/components/files/share-modal";
import { RenameModal } from "@/components/files/rename-modal";
import { MoveModal, type MoveTarget } from "@/components/files/move-modal";
import { TagsModal } from "@/components/files/tags-modal";
import { RowActionsMenu, type RowAction } from "@/components/files/row-actions-menu";
import { FileThumbnail } from "@/components/files/file-thumbnail";
import { SharingBadge } from "@/components/files/sharing-badge";

interface FavoriteItem {
  id: string;
  name: string;
  type: "file" | "folder";
  sizeBytes?: string;
  updatedAt: string;
}

export default function FavoritesPage() {
  const queryClient = useQueryClient();
  const [view, setView] = useViewPreference();
  const [previewItem, setPreviewItem] = React.useState<FavoriteItem | null>(null);
  const [shareItem, setShareItem] = React.useState<FavoriteItem | null>(null);
  const [renameItem, setRenameItem] = React.useState<FavoriteItem | null>(null);
  const [moveTargets, setMoveTargets] = React.useState<{ items: MoveTarget[]; label: string } | null>(null);
  const [tagsItem, setTagsItem] = React.useState<FavoriteItem | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.favorites(),
    queryFn: () => api.get<{ items: FavoriteItem[] }>("/favorites"),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.favorites() });
  }

  async function unfavorite(item: FavoriteItem) {
    await api.delete(`/items/${item.type}/${item.id}/favorite`);
    invalidate();
  }

  async function deleteItem(item: FavoriteItem) {
    await api.delete(item.type === "folder" ? `/folders/${item.id}` : `/files/${item.id}`);
    invalidate();
  }

  async function downloadFile(item: FavoriteItem) {
    // Opened synchronously, before the await below — a window.open() called only after an async
    // gap no longer counts as a direct result of the click to most browsers' popup blockers and
    // gets silently swallowed. Same pattern as the main file browser's downloadFile().
    const tab = window.open("", "_blank");
    const { url } = await api.get<{ url: string }>(`/files/${item.id}/download`);
    if (tab) tab.location.href = url;
  }

  function downloadFolderZip(item: FavoriteItem) {
    window.open(`/api/v1/folders/${item.id}/download-zip`, "_blank");
  }

  function actionsFor(item: FavoriteItem): RowAction[] {
    return [
      { label: "Rename", icon: Pencil, onSelect: () => setRenameItem(item) },
      {
        label: "Move",
        icon: FolderInput,
        onSelect: () => setMoveTargets({ items: [{ id: item.id, type: item.type }], label: `"${item.name}"` }),
      },
      { label: "Tags", icon: Tags, onSelect: () => setTagsItem(item) },
      { label: "Share", icon: Share2, onSelect: () => setShareItem(item) },
      {
        label: item.type === "folder" ? "Download as ZIP" : "Download",
        icon: Download,
        onSelect: () => (item.type === "folder" ? downloadFolderZip(item) : downloadFile(item)),
      },
      { label: "Delete", icon: Trash2, onSelect: () => deleteItem(item), destructive: true },
    ];
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Favorites</h1>
        {data && data.items.length > 0 && (
          <div className="flex items-center rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => setView("list")}
              aria-label="List view"
              aria-pressed={view === "list"}
              className={cn(
                "rounded px-2 py-1.5 text-muted-foreground hover:text-foreground",
                view === "list" && "bg-muted text-foreground",
              )}
            >
              <List className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setView("grid")}
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              className={cn(
                "rounded px-2 py-1.5 text-muted-foreground hover:text-foreground",
                view === "grid" && "bg-muted text-foreground",
              )}
            >
              <LayoutGrid className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">No favorites yet.</p>}

      {data && data.items.length > 0 && view === "list" && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="hidden w-28 px-4 py-2.5 font-medium sm:table-cell">Size</th>
                <th className="hidden w-36 px-4 py-2.5 font-medium md:table-cell">Modified</th>
                <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Sharing</th>
                <th className="w-12 px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.items.map((item) => (
                <tr key={item.id} className="group hover:bg-muted/30">
                  <td className="px-4 py-2.5 align-middle">
                    <div className="flex items-center gap-2.5">
                      {item.type === "folder" ? (
                        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      {item.type === "folder" ? (
                        <Link href={`/folders/${item.id}`} className="font-medium hover:underline">
                          {item.name}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPreviewItem(item)}
                          className="font-medium hover:underline"
                        >
                          {item.name}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => unfavorite(item)}
                        title="Remove from favorites"
                        className="text-accent opacity-100 transition-opacity hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
                      >
                        <Star className="h-3.5 w-3.5" fill="currentColor" aria-hidden />
                      </button>
                    </div>
                  </td>
                  <td className="hidden px-4 py-2.5 align-middle text-muted-foreground sm:table-cell">
                    {item.type === "file" && item.sizeBytes ? formatBytes(Number(item.sizeBytes)) : "—"}
                  </td>
                  <td className="hidden px-4 py-2.5 align-middle text-muted-foreground md:table-cell">
                    {formatDate(item.updatedAt)}
                  </td>
                  <td className="hidden px-4 py-2.5 align-middle text-muted-foreground lg:table-cell">
                    <SharingBadge itemType={item.type} itemId={item.id} />
                  </td>
                  <td className="px-4 py-2.5 align-middle">
                    <RowActionsMenu actions={actionsFor(item)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.items.length > 0 && view === "grid" && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {data.items.map((item) => (
            <div key={item.id} className="group relative flex flex-col rounded-lg border border-border hover:bg-muted/30">
              <button
                type="button"
                onClick={() => unfavorite(item)}
                title="Remove from favorites"
                className="absolute right-1.5 top-1.5 z-10 rounded-full bg-background/80 p-1 text-accent opacity-100 transition-opacity hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
              >
                <Star className="h-3.5 w-3.5" fill="currentColor" aria-hidden />
              </button>
              <div className="absolute right-1.5 bottom-[3.25rem] z-10 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                <RowActionsMenu actions={actionsFor(item)} />
              </div>

              {item.type === "folder" ? (
                <Link
                  href={`/folders/${item.id}`}
                  className="flex aspect-square items-center justify-center overflow-hidden rounded-t-lg bg-muted/40"
                >
                  <Folder className="h-10 w-10 text-muted-foreground" aria-hidden />
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => setPreviewItem(item)}
                  className="flex aspect-square items-center justify-center overflow-hidden rounded-t-lg bg-muted/40"
                >
                  <FileThumbnail fileId={item.id} />
                </button>
              )}

              <div className="truncate rounded-b-lg border-t border-border px-2.5 py-2 text-center text-sm font-medium">
                {item.name}
              </div>
            </div>
          ))}
        </div>
      )}

      {previewItem && (
        <FilePreviewModal fileId={previewItem.id} name={previewItem.name} onClose={() => setPreviewItem(null)} />
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
          onRenamed={invalidate}
        />
      )}

      {moveTargets && (
        <MoveModal
          items={moveTargets.items}
          label={moveTargets.label}
          onClose={() => setMoveTargets(null)}
          onMoved={invalidate}
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
