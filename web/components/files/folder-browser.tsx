"use client";

// Backs both /folders (root, folderId = null) and /folders/[folderId]. Calls the filesystem
// endpoints APPLICATION_DESIGN.md §4.3 documents — GET .../contents, POST /folders, DELETE
// /folders/:id, DELETE /files/:id, all implemented (Subcomponent 1). Rename isn't wired into
// this UI yet — this is still a minimal slice of the folder browser, not the full page.

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Home,
  ChevronRight,
  FolderPlus,
  Upload,
  Folder,
  FileText,
  Star,
  Pencil,
  FolderInput,
  Tags,
  Share2,
  Download,
  Trash2,
  List,
  LayoutGrid,
  X,
  UploadCloud,
} from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { useUploads } from "@/lib/uploads";
import { formatBytes, formatDate } from "@/lib/format";
import { useViewPreference } from "@/lib/use-view-preference";
import { Button } from "@/components/ui/button";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { ShareModal } from "@/components/files/share-modal";
import { RenameModal } from "@/components/files/rename-modal";
import { MoveModal, type MoveTarget } from "@/components/files/move-modal";
import { TagsModal } from "@/components/files/tags-modal";
import { NewFolderModal } from "@/components/files/new-folder-modal";
import { RowActionsMenu, type RowAction } from "@/components/files/row-actions-menu";
import { FileThumbnail } from "@/components/files/file-thumbnail";
import { SharingBadge } from "@/components/files/sharing-badge";

interface FolderContentsItem {
  id: string;
  name: string;
  type: "file" | "folder";
  sizeBytes?: string;
  updatedAt: string;
}

interface CurrentFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
}

export function FolderBrowser({ folderId }: { folderId: string | null }) {
  const queryClient = useQueryClient();
  const { startUpload } = useUploads();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [showNewFolderModal, setShowNewFolderModal] = React.useState(false);
  const [previewItem, setPreviewItem] = React.useState<FolderContentsItem | null>(null);
  const [shareItem, setShareItem] = React.useState<FolderContentsItem | null>(null);
  const [renameItem, setRenameItem] = React.useState<FolderContentsItem | null>(null);
  const [moveTargets, setMoveTargets] = React.useState<{ items: MoveTarget[]; label: string } | null>(null);
  const [tagsItem, setTagsItem] = React.useState<FolderContentsItem | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [view, setView] = useViewPreference();
  const [isDraggingOver, setIsDraggingOver] = React.useState(false);
  // dragenter/dragleave fire on every child element as the pointer crosses them, not just once
  // for the container — a plain boolean flips off mid-drag every time it passes over a row/table
  // cell. Counting enter/leave pairs and only clearing at zero is the standard fix.
  const dragCounterRef = React.useRef(0);

  // Internal item drag-to-move — dragging a row/card and dropping it onto a folder row/card
  // moves it there. Distinct from the onDragEnter/onDragOver/onDrop trio above, which is for
  // dragging files in from the OS to upload: those gate on
  // `e.dataTransfer.types.includes("Files")`, which a same-page HTML5 drag never sets (there's
  // no OS File object involved), so the two don't interfere with each other.
  const [draggedItem, setDraggedItem] = React.useState<FolderContentsItem | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = React.useState<string | null>(null);

  async function moveItemInto(item: FolderContentsItem, targetFolderId: string) {
    if (item.id === targetFolderId) return;
    await api.patch(
      item.type === "folder" ? `/folders/${item.id}` : `/files/${item.id}`,
      item.type === "folder" ? { parentFolderId: targetFolderId } : { folderId: targetFolderId },
    );
    queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(folderId) });
  }

  function onItemDragStart(e: React.DragEvent, item: FolderContentsItem) {
    e.dataTransfer.effectAllowed = "move";
    // Required for some browsers (notably Firefox) to allow the drag to start at all — the
    // actual move doesn't read this back, it uses the draggedItem state closed over below, since
    // this is always a same-page drag.
    e.dataTransfer.setData("text/plain", item.id);
    setDraggedItem(item);
  }

  function onItemDragEnd() {
    setDraggedItem(null);
    setDragOverFolderId(null);
  }

  function onFolderDragOver(e: React.DragEvent, target: FolderContentsItem) {
    if (target.type !== "folder" || !draggedItem || draggedItem.id === target.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverFolderId(target.id);
  }

  function onFolderDragLeave(target: FolderContentsItem) {
    setDragOverFolderId((prev) => (prev === target.id ? null : prev));
  }

  async function onFolderDrop(e: React.DragEvent, target: FolderContentsItem) {
    if (target.type !== "folder" || !draggedItem || draggedItem.id === target.id) return;
    e.preventDefault();
    e.stopPropagation(); // don't let the OS-file-upload dropzone on the outer container also fire
    setDragOverFolderId(null);
    const item = draggedItem;
    setDraggedItem(null);
    await moveItemInto(item, target.id);
  }

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.folderContents(folderId),
    queryFn: () =>
      api.get<{ folder: CurrentFolder | null; items: FolderContentsItem[] }>(
        folderId ? `/folders/${folderId}/contents` : "/folders/contents",
      ),
  });

  // Navigating into a different folder while items were selected left the old selection's ids
  // "active" against a table that no longer contains them — the bulk toolbar would still show a
  // stale count and act on ids not present in the new listing (harmless since ids are globally
  // unique, but the toolbar staying up across a navigation reads as broken, not just unlucky).
  React.useEffect(() => {
    setSelectedIds(new Set());
  }, [folderId]);

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

  // Unlike downloadFile above, this URL is already known synchronously (a same-origin backend
  // route, not a presigned S3 URL fetched via an async lookup first) — no need for the
  // open-a-blank-tab-then-redirect dance, a plain synchronous window.open() is still a direct
  // result of the click and won't get popup-blocked.
  function downloadFolderZip(item: FolderContentsItem) {
    window.open(`/api/v1/folders/${item.id}/download-zip`, "_blank");
  }

  function onFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      startUpload(file, folderId);
    }
    e.target.value = "";
  }

  // Files only, not folders — a dragged folder shows up as a DataTransferItem whose
  // webkitGetAsEntry() is a directory, which File()/startUpload() can't handle; recursively
  // walking that tree is real added scope this doesn't attempt, so a dropped folder is silently
  // skipped rather than uploaded as a broken zero-byte file.
  function onDragEnter(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setIsDraggingOver(true);
  }

  function onDragOver(e: React.DragEvent) {
    // No-op body, but preventDefault() is required here — without it the browser rejects the
    // drop entirely (its default handling of a dragover is "this element is not a drop target").
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
  }

  function onDragLeave(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDraggingOver(false);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);

    // dataTransfer.items (not the plain .files list) is what exposes webkitGetAsEntry() — the
    // only way to actually distinguish a dropped folder from a dropped file. .files alone
    // represents a dropped folder as a same-shaped File entry (0 bytes, empty type), which would
    // silently upload as a bogus empty file instead of being skipped as the comment above claims.
    const items = Array.from(e.dataTransfer.items);
    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry && !entry.isFile) continue; // a dropped folder — skipped, not attempted
      const file = item.getAsFile();
      if (file) startUpload(file, folderId);
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (!data) return;
    setSelectedIds((prev) => (prev.size === data.items.length ? new Set() : new Set(data.items.map((i) => i.id))));
  }

  function actionsFor(item: FolderContentsItem): RowAction[] {
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

  const selectedItems = data?.items.filter((i) => selectedIds.has(i.id)) ?? [];

  async function bulkDelete() {
    await Promise.all(selectedItems.map((item) => api.delete(item.type === "folder" ? `/folders/${item.id}` : `/files/${item.id}`)));
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(folderId) });
  }

  async function bulkDownload() {
    // Same synchronous-window.open() requirement as the single-file downloadFile() above, just
    // once per file up front so each open() call is still a direct result of this same click —
    // one deferred until after an await would get silently blocked, and here that'd be every one
    // past the first.
    const files = selectedItems.filter((i) => i.type === "file");
    const tabs = files.map(() => window.open("", "_blank"));
    await Promise.all(
      files.map(async (item, i) => {
        const { url } = await api.get<{ url: string }>(`/files/${item.id}/download`);
        const tab = tabs[i];
        if (tab) tab.location.href = url;
      }),
    );
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  return (
    <div
      className="relative space-y-4"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDraggingOver && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10">
          <div className="flex flex-col items-center gap-2 text-accent">
            <UploadCloud className="h-8 w-8" aria-hidden />
            <span className="text-sm font-medium">Drop files to upload</span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/folders" className="hover:text-foreground" aria-label="Home">
            <Home className="h-4 w-4" aria-hidden />
          </Link>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          <Link href="/folders" className="hover:text-foreground">
            My Files
          </Link>
          {data?.folder && (
            <>
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              <span className="font-semibold text-foreground">{data.folder.name}</span>
            </>
          )}
        </nav>

        <div className="flex items-center gap-2">
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
          <Button variant="outline" size="sm" onClick={() => setShowNewFolderModal(true)}>
            <FolderPlus className="mr-1.5 h-4 w-4" aria-hidden />
            New Folder
          </Button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFilesSelected} />
          <Button size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="mr-1.5 h-4 w-4" aria-hidden />
            Upload
          </Button>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-accent/10 px-4 py-2">
          <span className="text-sm font-medium">
            {selectedIds.size} selected
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setMoveTargets({
                  items: selectedItems.map((i) => ({ id: i.id, type: i.type })),
                  label: `${selectedItems.length} item${selectedItems.length === 1 ? "" : "s"}`,
                })
              }
            >
              <FolderInput className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Move
            </Button>
            {selectedItems.some((i) => i.type === "file") && (
              <Button variant="outline" size="sm" onClick={bulkDownload}>
                <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                Download
              </Button>
            )}
            <Button variant="destructive" size="sm" onClick={bulkDelete}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={clearSelection} aria-label="Clear selection">
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p className="text-sm text-destructive">
          {error instanceof ApiError ? error.message : "Could not load this folder."}
        </p>
      )}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">This folder is empty.</p>}

      {data && data.items.length > 0 && view === "list" && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 shrink-0 appearance-none rounded border border-muted-foreground/40 bg-transparent checked:border-accent checked:bg-accent"
                    checked={selectedIds.size > 0 && selectedIds.size === data.items.length}
                    onChange={toggleSelectAll}
                    aria-label="Select all"
                  />
                </th>
                <th className="px-2 py-2.5 font-medium">Name</th>
                <th className="hidden w-28 px-4 py-2.5 font-medium sm:table-cell">Size</th>
                <th className="hidden w-36 px-4 py-2.5 font-medium md:table-cell">Modified</th>
                <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Sharing</th>
                <th className="w-12 px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.items.map((item) => {
                const isSelected = selectedIds.has(item.id);
                return (
                  <tr
                    key={item.id}
                    draggable
                    onDragStart={(e) => onItemDragStart(e, item)}
                    onDragEnd={onItemDragEnd}
                    onDragOver={(e) => onFolderDragOver(e, item)}
                    onDragLeave={() => onFolderDragLeave(item)}
                    onDrop={(e) => onFolderDrop(e, item)}
                    className={cn(
                      "group hover:bg-muted/30",
                      isSelected && "bg-accent/10",
                      dragOverFolderId === item.id && "bg-accent/20 ring-2 ring-inset ring-accent",
                    )}
                  >
                    <td className="px-4 py-2.5 align-middle">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 shrink-0 appearance-none rounded border border-muted-foreground/40 bg-transparent checked:border-accent checked:bg-accent"
                        checked={isSelected}
                        onChange={() => toggleSelected(item.id)}
                        aria-label={`Select ${item.name}`}
                      />
                    </td>
                    <td className="px-2 py-2.5 align-middle">
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
                          onClick={() => toggleFavorite(item)}
                          title="Favorite"
                          className={cn(
                            "text-muted-foreground opacity-100 transition-opacity hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100",
                            favoritedIds.has(item.id) && "opacity-100 text-accent",
                          )}
                        >
                          <Star className="h-3.5 w-3.5" fill={favoritedIds.has(item.id) ? "currentColor" : "none"} aria-hidden />
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && data.items.length > 0 && view === "grid" && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {data.items.map((item) => {
            const isSelected = selectedIds.has(item.id);
            return (
            <div
              key={item.id}
              draggable
              onDragStart={(e) => onItemDragStart(e, item)}
              onDragEnd={onItemDragEnd}
              onDragOver={(e) => onFolderDragOver(e, item)}
              onDragLeave={() => onFolderDragLeave(item)}
              onDrop={(e) => onFolderDrop(e, item)}
              className={cn(
                "group relative flex flex-col rounded-lg border border-border hover:bg-muted/30",
                isSelected && "border-accent bg-accent/10",
                dragOverFolderId === item.id && "border-accent bg-accent/20 ring-2 ring-inset ring-accent",
              )}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleSelected(item.id)}
                aria-label={`Select ${item.name}`}
                className={cn(
                  "absolute left-1.5 top-1.5 z-10 h-3.5 w-3.5 shrink-0 appearance-none rounded border border-muted-foreground/40 bg-background/80 opacity-100 transition-opacity checked:border-accent checked:bg-accent sm:opacity-0 sm:group-hover:opacity-100",
                  isSelected && "opacity-100",
                )}
              />
              <button
                type="button"
                onClick={() => toggleFavorite(item)}
                title="Favorite"
                className={cn(
                  "absolute right-1.5 top-1.5 z-10 rounded-full bg-background/80 p-1 text-muted-foreground opacity-100 transition-opacity hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100",
                  favoritedIds.has(item.id) && "opacity-100 text-accent",
                )}
              >
                <Star className="h-3.5 w-3.5" fill={favoritedIds.has(item.id) ? "currentColor" : "none"} aria-hidden />
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
            );
          })}
        </div>
      )}

      {showNewFolderModal && (
        <NewFolderModal
          parentFolderId={folderId}
          onClose={() => setShowNewFolderModal(false)}
          onCreated={() => queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(folderId) })}
        />
      )}

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

      {moveTargets && (
        <MoveModal
          items={moveTargets.items}
          label={moveTargets.label}
          onClose={() => setMoveTargets(null)}
          onMoved={() => {
            setSelectedIds(new Set());
            queryClient.invalidateQueries({ queryKey: queryKeys.folderContents(folderId) });
          }}
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
