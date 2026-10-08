"use client";

// REQUIREMENTS.md §5.5: access without requiring an account — the one route outside the
// authenticated (app) shell entirely (FRONTEND_DESIGN.md §4.2). Not wrapped in AuthProvider's
// redirect gates since it has none; it does still sit under the root layout's Providers (query
// client), just not (app)'s or (auth)'s route-group layouts.
//
// Rebuilt from a bare name-only list to the same browsing experience My Files gives a logged-in
// user — list/grid toggle, click-to-open, a 3-dot menu — scoped down to what an anonymous visitor
// can actually do: browse into subfolders of a folder-type link, preview/download files, and
// download a folder as a zip. No tags/favorites/rename/move/delete here — those are account
// features (tags and favorites are explicitly personal-to-a-user, REQUIREMENTS.md §5.8) with no
// meaning for a visitor who isn't signed in, and write access isn't part of a public link at all
// yet (§5.5 marks it out of scope).

import * as React from "react";
import { use, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpDown, Download, Filter, Folder, FileText, List, LayoutGrid, SearchIcon, X } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { formatBytes, formatDate } from "@/lib/format";
import { fileCategory } from "@/lib/file-category";
import { Button } from "@/components/ui/button";
import { VideoPlayer } from "@/components/files/video-player";
import { Input } from "@/components/ui/input";
import { SelectMenu } from "@/components/ui/select-menu";
import { RowActionsMenu, type RowAction } from "@/components/files/row-actions-menu";

interface SharedItem {
  id: string;
  name: string;
  type: "file" | "folder";
  sizeBytes?: string;
  mimeType?: string;
  updatedAt: string;
}

interface SharedFolderContents {
  name: string;
  role: "viewer" | "editor";
  folderId: string | null;
  parentFolderId: string | null;
  isRoot: boolean;
  items: SharedItem[];
}

interface PublicPreviewResponse {
  available: boolean;
  url?: string;
  mimeType?: string;
}

// A password-protected link's password is never sent with these requests: the unlock form posts it
// once to /unlock, which sets an httpOnly cookie scoped to this link's API path that the browser
// attaches automatically (fetches and plain <a>/window.open downloads alike).
function PublicThumbnail({ token, fileId }: { token: string; fileId: string }) {
  const { data } = useQuery({
    queryKey: ["public-share-link", token, "thumbnail", fileId],
    queryFn: () =>
      api.get<{ available: boolean; url?: string }>(`/public/share-links/${token}/files/${fileId}/thumbnail`),
    staleTime: 60_000,
  });

  if (data?.available && data.url) {
    return <img src={data.url} alt="" className="h-full w-full object-cover" />;
  }
  return <FileText className="h-8 w-8 text-muted-foreground" aria-hidden />;
}

function PublicFilePreviewModal({
  token,
  fileId,
  name,
  onClose,
}: {
  token: string;
  fileId: string;
  name: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["public-share-link", token, "preview", fileId],
    queryFn: () => api.get<PublicPreviewResponse>(`/public/share-links/${token}/files/${fileId}/preview`),
  });

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function download() {
    const tab = window.open("", "_blank");
    const { url } = await api.get<{ url: string }>(`/public/share-links/${token}/files/${fileId}/download`);
    if (tab) tab.location.href = url;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-md bg-background"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="truncate text-sm font-medium">{name}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={download}>
              Download
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>

        <div className="flex min-h-[300px] flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
          {isLoading && <p className="text-sm text-muted-foreground">Loading preview…</p>}
          {!isLoading && !data?.available && (
            <p className="text-sm text-muted-foreground">No preview available for this file.</p>
          )}
          {data?.available && data.mimeType?.startsWith("image/") && (
            <img src={data.url} alt={name} className="max-h-[70vh] max-w-full object-contain" />
          )}
          {data?.available && data.mimeType?.startsWith("video/") && (
            <VideoPlayer src={data.url!} className="max-h-[70vh] max-w-full" />
          )}
          {data?.available && data.mimeType?.startsWith("audio/") && (
            <audio src={data.url} controls className="w-full max-w-md" />
          )}
          {data?.available && data.mimeType === "application/pdf" && (
            <iframe src={data.url} title={name} className="h-[75vh] w-full border-0" />
          )}
        </div>
      </div>
    </div>
  );
}

// Next.js 15: `params` is a Promise; use() unwraps it in this Client Component (see the same
// pattern's comment in admin/users/[userId]/page.tsx). useSearchParams() (for the `folder` deep
// link below) requires a Suspense boundary around anything that calls it, even in a page that's
// already fully client-rendered — without one, the build fails to prerender a fallback shell.
export default function PublicShareLinkPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense
      fallback={<div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>}
    >
      <PublicShareLinkContent params={params} />
    </Suspense>
  );
}

function PublicShareLinkContent({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const folderId = searchParams.get("folder") ?? undefined;

  const queryClient = useQueryClient();
  const [password, setPassword] = React.useState("");
  const [unlockError, setUnlockError] = React.useState<string | null>(null);
  const [unlocking, setUnlocking] = React.useState(false);
  const [view, setView] = React.useState<"list" | "grid">("list");
  const [previewItem, setPreviewItem] = React.useState<SharedItem | null>(null);
  // Same client-side search/filter/sort as the authenticated folder browser (folder-browser.tsx)
  // — a visitor here has no account and no server-side search endpoint available to them, so this
  // filters whatever's already loaded for the current folder rather than hitting the backend.
  const [searchQuery, setSearchQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<
    "all" | "folder" | "image" | "video" | "audio" | "document"
  >("all");
  const [sortKey, setSortKey] = React.useState<
    "name-asc" | "name-desc" | "size-desc" | "size-asc" | "modified-desc" | "modified-asc"
  >("name-asc");

  const { data, error, isLoading } = useQuery({
    queryKey: ["public-share-link", token, "contents", folderId],
    queryFn: () =>
      api.get<SharedFolderContents>(
        `/public/share-links/${token}${folderId ? `?${new URLSearchParams({ folderId }).toString()}` : ""}`,
      ),
  });

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setUnlocking(true);
    setUnlockError(null);
    try {
      await api.post(`/public/share-links/${token}/unlock`, { password });
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["public-share-link", token] });
    } catch (err) {
      setUnlockError(
        err instanceof ApiError && err.code === "INVALID_PASSWORD"
          ? "Incorrect password."
          : err instanceof ApiError && err.code === "RATE_LIMITED"
            ? "Too many attempts. Try again later."
            : "Could not unlock this link.",
      );
    } finally {
      setUnlocking(false);
    }
  }

  const needsPassword = error instanceof ApiError && error.status === 401;

  React.useEffect(() => {
    setSearchQuery("");
  }, [folderId]);

  const filteredItems = React.useMemo(() => {
    if (!data) return [];
    const q = searchQuery.trim().toLowerCase();
    const matches = data.items.filter((item) => {
      if (q && !item.name.toLowerCase().includes(q)) return false;
      if (typeFilter === "folder") return item.type === "folder";
      if (typeFilter !== "all") {
        if (item.type !== "file") return false;
        return fileCategory(item.mimeType) === typeFilter;
      }
      return true;
    });

    return [...matches].sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      switch (sortKey) {
        case "name-asc":
          return a.name.localeCompare(b.name);
        case "name-desc":
          return b.name.localeCompare(a.name);
        case "size-asc":
          return Number(a.sizeBytes ?? 0) - Number(b.sizeBytes ?? 0);
        case "size-desc":
          return Number(b.sizeBytes ?? 0) - Number(a.sizeBytes ?? 0);
        case "modified-asc":
          return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        case "modified-desc":
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        default:
          return 0;
      }
    });
  }, [data, searchQuery, typeFilter, sortKey]);

  function openFolder(id: string) {
    router.push(`?folder=${id}`);
  }

  function goBack() {
    if (data?.parentFolderId) router.push(`?folder=${data.parentFolderId}`);
    else router.push("?");
  }

  async function downloadFile(item: SharedItem) {
    const tab = window.open("", "_blank");
    const { url } = await api.get<{ url: string }>(`/public/share-links/${token}/files/${item.id}/download`);
    if (tab) tab.location.href = url;
  }

  function downloadFolderZip(folderId: string) {
    window.open(`/api/v1/public/share-links/${token}/folders/${folderId}/download-zip`, "_blank");
  }

  function actionsFor(item: SharedItem): RowAction[] {
    return item.type === "folder"
      ? [{ label: "Download as ZIP", icon: Download, onSelect: () => downloadFolderZip(item.id) }]
      : [{ label: "Download", icon: Download, onSelect: () => downloadFile(item) }];
  }

  if (needsPassword) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <form
          onSubmit={unlock}
          className="w-full max-w-sm space-y-4 rounded-lg border border-border p-6"
        >
          <h1 className="text-lg font-semibold">This link is password-protected</h1>
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {unlockError && <p className="text-sm text-destructive">{unlockError}</p>}
          <Button type="submit" className="w-full" disabled={unlocking || password.length === 0}>
            {unlocking ? "Unlocking…" : "Unlock"}
          </Button>
        </form>
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-destructive">
        This link is invalid, expired, or no longer available.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {!data?.isRoot && (
            <Button variant="ghost" size="sm" onClick={goBack} aria-label="Back">
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </Button>
          )}
          <h1 className="text-xl font-semibold">{data?.name}</h1>
        </div>
        {data && (data.folderId || data.items.length > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {data.folderId && (
              <Button variant="outline" size="sm" onClick={() => downloadFolderZip(data.folderId!)}>
                <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                Download as ZIP
              </Button>
            )}

            {data.items.length > 0 && (
              <>
            <div className="relative">
              <SearchIcon
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search…"
                className="h-8 w-36 pl-8 text-sm sm:w-48"
              />
            </div>

            <SelectMenu
              value={typeFilter}
              onChange={setTypeFilter}
              icon={Filter}
              ariaLabel="Filter by type"
              options={[
                { value: "all", label: "All items" },
                { value: "folder", label: "Folders only" },
                { value: "image", label: "Images" },
                { value: "video", label: "Videos" },
                { value: "audio", label: "Audio" },
                { value: "document", label: "Files" },
              ]}
            />

            <SelectMenu
              value={sortKey}
              onChange={setSortKey}
              icon={ArrowUpDown}
              ariaLabel="Sort by"
              options={[
                { value: "name-asc", label: "Name (A–Z)" },
                { value: "name-desc", label: "Name (Z–A)" },
                { value: "modified-desc", label: "Newest first" },
                { value: "modified-asc", label: "Oldest first" },
                { value: "size-desc", label: "Largest first" },
                { value: "size-asc", label: "Smallest first" },
              ]}
            />

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
              </>
            )}
          </div>
        )}
      </div>

      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">This folder is empty.</p>}
      {data && data.items.length > 0 && filteredItems.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {searchQuery.trim() ? <>No files or folders match &quot;{searchQuery}&quot;.</> : "Nothing matches the current filter."}
        </p>
      )}

      {filteredItems.length > 0 && view === "list" && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="hidden w-28 px-4 py-2.5 font-medium sm:table-cell">Size</th>
                <th className="hidden w-36 px-4 py-2.5 font-medium md:table-cell">Modified</th>
                <th className="w-12 px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredItems.map((item) => (
                <tr key={item.id} className="group hover:bg-muted/30">
                  <td className="px-4 py-2.5 align-middle">
                    <div className="flex items-center gap-2.5">
                      {item.type === "folder" ? (
                        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      {item.type === "folder" ? (
                        <button type="button" onClick={() => openFolder(item.id)} className="font-medium hover:underline">
                          {item.name}
                        </button>
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
                  <td className="px-4 py-2.5 align-middle">
                    <RowActionsMenu actions={actionsFor(item)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filteredItems.length > 0 && view === "grid" && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {filteredItems.map((item) => (
            <div key={item.id} className="group relative flex flex-col rounded-lg border border-border hover:bg-muted/30">
              <div className="absolute right-1.5 top-1.5 z-10 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                <RowActionsMenu actions={actionsFor(item)} />
              </div>

              {item.type === "folder" ? (
                <button
                  type="button"
                  onClick={() => openFolder(item.id)}
                  className="flex aspect-square items-center justify-center overflow-hidden rounded-t-lg bg-muted/40"
                >
                  <Folder className="h-10 w-10 text-muted-foreground" aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setPreviewItem(item)}
                  className="flex aspect-square items-center justify-center overflow-hidden rounded-t-lg bg-muted/40"
                >
                  <PublicThumbnail token={token} fileId={item.id} />
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
        <PublicFilePreviewModal
          token={token}
          fileId={previewItem.id}
          name={previewItem.name}
          onClose={() => setPreviewItem(null)}
        />
      )}
    </div>
  );
}
