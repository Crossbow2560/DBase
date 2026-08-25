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
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, Folder, FileText, List, LayoutGrid, X } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { formatBytes, formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

function PublicThumbnail({ token, password, fileId }: { token: string; password?: string; fileId: string }) {
  const { data } = useQuery({
    queryKey: ["public-share-link", token, "thumbnail", fileId, password],
    queryFn: () =>
      api.get<{ available: boolean; url?: string }>(
        `/public/share-links/${token}/files/${fileId}/thumbnail${password ? `?password=${encodeURIComponent(password)}` : ""}`,
      ),
    staleTime: 60_000,
  });

  if (data?.available && data.url) {
    return <img src={data.url} alt="" className="h-full w-full object-cover" />;
  }
  return <FileText className="h-8 w-8 text-muted-foreground" aria-hidden />;
}

function PublicFilePreviewModal({
  token,
  password,
  fileId,
  name,
  onClose,
}: {
  token: string;
  password?: string;
  fileId: string;
  name: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["public-share-link", token, "preview", fileId, password],
    queryFn: () =>
      api.get<PublicPreviewResponse>(
        `/public/share-links/${token}/files/${fileId}/preview${password ? `?password=${encodeURIComponent(password)}` : ""}`,
      ),
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
    const { url } = await api.get<{ url: string }>(
      `/public/share-links/${token}/files/${fileId}/download${password ? `?password=${encodeURIComponent(password)}` : ""}`,
    );
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
            <video src={data.url} controls autoPlay className="max-h-[70vh] max-w-full" />
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

  const [password, setPassword] = React.useState("");
  const [submittedPassword, setSubmittedPassword] = React.useState<string | undefined>(undefined);
  const [view, setView] = React.useState<"list" | "grid">("list");
  const [previewItem, setPreviewItem] = React.useState<SharedItem | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: ["public-share-link", token, submittedPassword, folderId],
    queryFn: () =>
      api.get<SharedFolderContents>(
        `/public/share-links/${token}?${new URLSearchParams({
          ...(submittedPassword ? { password: submittedPassword } : {}),
          ...(folderId ? { folderId } : {}),
        }).toString()}`,
      ),
  });

  const needsPassword = error instanceof ApiError && error.status === 401;

  function openFolder(id: string) {
    router.push(`?folder=${id}`);
  }

  function goBack() {
    if (data?.parentFolderId) router.push(`?folder=${data.parentFolderId}`);
    else router.push("?");
  }

  async function downloadFile(item: SharedItem) {
    const tab = window.open("", "_blank");
    const { url } = await api.get<{ url: string }>(
      `/public/share-links/${token}/files/${item.id}/download${submittedPassword ? `?password=${encodeURIComponent(submittedPassword)}` : ""}`,
    );
    if (tab) tab.location.href = url;
  }

  function downloadFolderZip(item: SharedItem) {
    const qs = submittedPassword ? `?password=${encodeURIComponent(submittedPassword)}` : "";
    window.open(`/api/v1/public/share-links/${token}/folders/${item.id}/download-zip${qs}`, "_blank");
  }

  function actionsFor(item: SharedItem): RowAction[] {
    return item.type === "folder"
      ? [{ label: "Download as ZIP", icon: Download, onSelect: () => downloadFolderZip(item) }]
      : [{ label: "Download", icon: Download, onSelect: () => downloadFile(item) }];
  }

  if (needsPassword) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmittedPassword(password);
          }}
          className="w-full max-w-sm space-y-4 rounded-lg border border-border p-6"
        >
          <h1 className="text-lg font-semibold">This link is password-protected</h1>
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" className="w-full">
            Unlock
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

      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">This folder is empty.</p>}

      {data && data.items.length > 0 && view === "list" && (
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

      {data && data.items.length > 0 && view === "grid" && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {data.items.map((item) => (
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
                  <PublicThumbnail token={token} password={submittedPassword} fileId={item.id} />
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
          password={submittedPassword}
          fileId={previewItem.id}
          name={previewItem.name}
          onClose={() => setPreviewItem(null)}
        />
      )}
    </div>
  );
}
