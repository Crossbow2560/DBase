"use client";

// REQUIREMENTS.md §5.8 — manage your own personal tag definitions, and browse items filed under
// them. Applying a tag to a specific file/folder still happens from the file browser's Tags button
// (components/files/tags-modal.tsx) — this page owns create/list/recolor/delete of the tag
// definitions themselves, plus a read-only-membership browse view once a tag is selected.

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tag as TagIcon, Trash2, Plus, X, Folder, FileText, Star, Pencil, FolderInput, Tags as TagsIcon, Share2, Download } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { formatBytes, formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColorPicker } from "@/components/ui/color-picker";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { ShareModal } from "@/components/files/share-modal";
import { RenameModal } from "@/components/files/rename-modal";
import { MoveModal, type MoveTarget } from "@/components/files/move-modal";
import { TagsModal } from "@/components/files/tags-modal";
import { RowActionsMenu, type RowAction } from "@/components/files/row-actions-menu";
import { FileThumbnail } from "@/components/files/file-thumbnail";
import { SharingBadge } from "@/components/files/sharing-badge";

interface Tag {
  id: string;
  name: string;
  color: string | null;
}

interface TaggedItem {
  id: string;
  name: string;
  type: "file" | "folder";
  sizeBytes?: string;
  updatedAt: string;
}

export default function TagsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [newTagColor, setNewTagColor] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedTagId, setSelectedTagId] = React.useState<string | null>(null);
  const [editingColorTagId, setEditingColorTagId] = React.useState<string | null>(null);

  const [previewItem, setPreviewItem] = React.useState<TaggedItem | null>(null);
  const [shareItem, setShareItem] = React.useState<TaggedItem | null>(null);
  const [renameItem, setRenameItem] = React.useState<TaggedItem | null>(null);
  const [moveTargets, setMoveTargets] = React.useState<{ items: MoveTarget[]; label: string } | null>(null);
  const [tagsItem, setTagsItem] = React.useState<TaggedItem | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["tags"],
    queryFn: () => api.get<{ tags: Tag[] }>("/tags"),
  });

  const selectedTag = data?.tags.find((t) => t.id === selectedTagId) ?? null;

  const { data: itemsData, isLoading: itemsLoading } = useQuery({
    queryKey: ["tags", selectedTagId, "items"],
    queryFn: () => api.get<{ items: TaggedItem[] }>(`/tags/${selectedTagId}/items`),
    enabled: !!selectedTagId,
  });

  const { data: favoritesData } = useQuery({
    queryKey: queryKeys.favorites(),
    queryFn: () => api.get<{ items: { id: string }[] }>("/favorites"),
  });
  const favoritedIds = new Set(favoritesData?.items.map((f) => f.id));

  function invalidateTags() {
    queryClient.invalidateQueries({ queryKey: ["tags"] });
  }

  function invalidateItems() {
    queryClient.invalidateQueries({ queryKey: ["tags", selectedTagId, "items"] });
  }

  async function createTag(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      await api.post("/tags", { name, color: newTagColor });
      setName("");
      setNewTagColor(null);
      invalidateTags();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create tag.");
    }
  }

  async function deleteTag(tag: Tag) {
    await api.delete(`/tags/${tag.id}`);
    if (selectedTagId === tag.id) setSelectedTagId(null);
    invalidateTags();
  }

  async function setTagColor(tag: Tag, color: string | null) {
    await api.patch(`/tags/${tag.id}`, { color });
    invalidateTags();
  }

  async function toggleFavorite(item: TaggedItem) {
    if (favoritedIds.has(item.id)) {
      await api.delete(`/items/${item.type}/${item.id}/favorite`);
    } else {
      await api.post(`/items/${item.type}/${item.id}/favorite`);
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.favorites() });
  }

  async function deleteItem(item: TaggedItem) {
    await api.delete(item.type === "folder" ? `/folders/${item.id}` : `/files/${item.id}`);
    invalidateItems();
  }

  async function downloadFile(item: TaggedItem) {
    const tab = window.open("", "_blank");
    const { url } = await api.get<{ url: string }>(`/files/${item.id}/download`);
    if (tab) tab.location.href = url;
  }

  function downloadFolderZip(item: TaggedItem) {
    window.open(`/api/v1/folders/${item.id}/download-zip`, "_blank");
  }

  function actionsFor(item: TaggedItem): RowAction[] {
    return [
      { label: "Rename", icon: Pencil, onSelect: () => setRenameItem(item) },
      {
        label: "Move",
        icon: FolderInput,
        onSelect: () => setMoveTargets({ items: [{ id: item.id, type: item.type }], label: `"${item.name}"` }),
      },
      { label: "Tags", icon: TagsIcon, onSelect: () => setTagsItem(item) },
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
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Tags</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Personal labels — only you can see or apply your tags, even on items you don&apos;t own.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-4">
          <form onSubmit={createTag} className="space-y-2 rounded-lg border border-border p-3">
            <Input placeholder="New tag name" value={name} onChange={(e) => setName(e.target.value)} />
            <ColorPicker value={newTagColor} onChange={setNewTagColor} />
            <Button type="submit" size="sm" className="w-full">
              <Plus className="mr-1 h-4 w-4" aria-hidden />
              Create tag
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </form>

          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {data && data.tags.length === 0 && <p className="text-sm text-muted-foreground">No tags yet.</p>}

          {data && data.tags.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-border">
              <ul className="divide-y divide-border">
                {data.tags.map((tag) => (
                  <li key={tag.id} className={cn("group relative", selectedTagId === tag.id && "bg-accent/10")}>
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => setEditingColorTagId(editingColorTagId === tag.id ? null : tag.id)}
                        title="Change color"
                        className="shrink-0 rounded-full p-1 hover:bg-muted"
                      >
                        <TagIcon
                          className={cn("h-4 w-4", !tag.color && "text-muted-foreground")}
                          style={tag.color ? { color: tag.color } : undefined}
                          aria-hidden
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedTagId(selectedTagId === tag.id ? null : tag.id)}
                        className={cn(
                          "flex-1 truncate py-1 text-left text-sm font-medium",
                          selectedTagId === tag.id && "text-accent",
                        )}
                      >
                        {tag.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteTag(tag)}
                        title="Delete tag"
                        className="shrink-0 rounded-md p-1 text-muted-foreground opacity-100 transition-opacity hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                    {editingColorTagId === tag.id && (
                      <div className="flex items-center gap-2 border-t border-border bg-muted/20 px-3 py-2.5">
                        <ColorPicker value={tag.color} onChange={(color) => setTagColor(tag, color)} />
                        <button
                          type="button"
                          onClick={() => setEditingColorTagId(null)}
                          className="ml-auto shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground"
                          aria-label="Close"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="min-w-0">
          {!selectedTag && (
            <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
              Select a tag to see what&apos;s filed under it.
            </div>
          )}

          {selectedTag && (
            <div className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                <TagIcon
                  className={cn("h-4 w-4", !selectedTag.color && "text-muted-foreground")}
                  style={selectedTag.color ? { color: selectedTag.color } : undefined}
                  aria-hidden
                />
                Tagged &ldquo;{selectedTag.name}&rdquo;
              </h2>

              {itemsLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
              {itemsData && itemsData.items.length === 0 && (
                <p className="text-sm text-muted-foreground">Nothing is tagged with this yet.</p>
              )}

              {itemsData && itemsData.items.length > 0 && (
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
                      {itemsData.items.map((item) => (
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
            </div>
          )}
        </div>
      </div>

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
          onRenamed={invalidateItems}
        />
      )}

      {moveTargets && (
        <MoveModal
          items={moveTargets.items}
          label={moveTargets.label}
          onClose={() => setMoveTargets(null)}
          onMoved={invalidateItems}
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
