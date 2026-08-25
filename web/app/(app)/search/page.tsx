"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, FileText, SearchIcon, Star, Pencil, FolderInput, Tags, Share2, Download, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { formatBytes, formatDate } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { ShareModal } from "@/components/files/share-modal";
import { RenameModal } from "@/components/files/rename-modal";
import { MoveModal, type MoveTarget } from "@/components/files/move-modal";
import { TagsModal } from "@/components/files/tags-modal";
import { RowActionsMenu, type RowAction } from "@/components/files/row-actions-menu";
import { SharingBadge } from "@/components/files/sharing-badge";

interface SearchResultItem {
  id: string;
  name: string;
  type: "file" | "folder";
  sizeBytes?: string;
  mimeType?: string;
  updatedAt: string;
}

export default function SearchPage() {
  const queryClient = useQueryClient();
  const [term, setTerm] = React.useState("");

  const [previewItem, setPreviewItem] = React.useState<SearchResultItem | null>(null);
  const [shareItem, setShareItem] = React.useState<SearchResultItem | null>(null);
  const [renameItem, setRenameItem] = React.useState<SearchResultItem | null>(null);
  const [moveTargets, setMoveTargets] = React.useState<{ items: MoveTarget[]; label: string } | null>(null);
  const [tagsItem, setTagsItem] = React.useState<SearchResultItem | null>(null);

  const { data, isFetching } = useQuery({
    queryKey: queryKeys.search(term),
    queryFn: () => api.get<{ items: SearchResultItem[] }>(`/search?q=${encodeURIComponent(term)}`),
    enabled: term.trim().length > 0,
  });

  const { data: favoritesData } = useQuery({
    queryKey: queryKeys.favorites(),
    queryFn: () => api.get<{ items: { id: string }[] }>("/favorites"),
  });
  const favoritedIds = new Set(favoritesData?.items.map((f) => f.id));

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.search(term) });
  }

  async function toggleFavorite(item: SearchResultItem) {
    if (favoritedIds.has(item.id)) {
      await api.delete(`/items/${item.type}/${item.id}/favorite`);
    } else {
      await api.post(`/items/${item.type}/${item.id}/favorite`);
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.favorites() });
  }

  async function deleteItem(item: SearchResultItem) {
    await api.delete(item.type === "folder" ? `/folders/${item.id}` : `/files/${item.id}`);
    invalidate();
  }

  async function downloadFile(item: SearchResultItem) {
    // Opened synchronously, before the await below — see folder-browser.tsx's identical comment
    // on why (a window.open() after an async gap gets silently swallowed by popup blockers).
    const tab = window.open("", "_blank");
    const { url } = await api.get<{ url: string }>(`/files/${item.id}/download`);
    if (tab) tab.location.href = url;
  }

  function downloadFolderZip(item: SearchResultItem) {
    window.open(`/api/v1/folders/${item.id}/download-zip`, "_blank");
  }

  function actionsFor(item: SearchResultItem): RowAction[] {
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
      <h1 className="text-xl font-semibold">Search</h1>
      <div className="relative max-w-md">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          placeholder="Search files and folders…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          className="pl-9"
        />
      </div>

      {isFetching && <p className="text-sm text-muted-foreground">Searching…</p>}
      {!isFetching && term.trim().length > 0 && data && data.items.length === 0 && (
        <p className="text-sm text-muted-foreground">No results for &quot;{term}&quot;.</p>
      )}

      {data && data.items.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="hidden w-28 px-4 py-2.5 font-medium sm:table-cell">Size</th>
                <th className="hidden w-36 px-4 py-2.5 font-medium md:table-cell">Modified</th>
                <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Sharing</th>
                <th className="w-20 px-4 py-2.5 font-medium"></th>
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
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => toggleFavorite(item)}
                        title="Favorite"
                        className={cn(
                          "text-muted-foreground opacity-100 transition-opacity hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100",
                          favoritedIds.has(item.id) && "opacity-100 text-accent",
                        )}
                      >
                        <Star className="h-3.5 w-3.5" fill={favoritedIds.has(item.id) ? "currentColor" : "none"} aria-hidden />
                      </button>
                      <RowActionsMenu actions={actionsFor(item)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
