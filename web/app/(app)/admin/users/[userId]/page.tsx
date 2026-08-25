"use client";

// Browse-only — see the action-placement note on /admin/users: mutating actions
// (deactivate/delete/quota/role) live on that list page, not duplicated here. "Browse-only" was
// never meant to mean "unopenable" though — an admin investigating a user's account needs to
// actually look inside folders and files, not just see a flat list of names with nothing behind
// them. Every load of this page is itself a `view` action the backend must log (REQUIREMENTS.md
// §5.10, once per browsing session, not per file — APPLICATION_DESIGN.md §4.6), which is the
// backend's responsibility on the GET /admin/users/:id/files call, not something this page does.

import * as React from "react";
import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Folder, FileText, Download } from "lucide-react";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { formatBytes, formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { RowActionsMenu, type RowAction } from "@/components/files/row-actions-menu";

interface AdminFileItem {
  id: string;
  name: string;
  type: "file" | "folder";
  sizeBytes?: string;
  mimeType?: string;
  updatedAt: string;
}

interface AdminFilesResponse {
  folder: { id: string; name: string; parentFolderId: string | null } | null;
  items: AdminFileItem[];
}

// Next.js 15: `params` is a Promise. This is a Client Component (uses useQuery), so it can't be
// an async function — React's use() unwraps the Promise synchronously instead.
export default function AdminUserFilesPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  const [folderId, setFolderId] = React.useState<string | undefined>(undefined);
  const [previewItem, setPreviewItem] = React.useState<AdminFileItem | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminUserFiles(userId, folderId),
    queryFn: () =>
      api.get<AdminFilesResponse>(
        `/admin/users/${userId}/files${folderId ? `?folderId=${folderId}` : ""}`,
      ),
  });

  async function downloadFile(item: AdminFileItem) {
    const tab = window.open("", "_blank");
    const { url } = await api.get<{ url: string }>(`/files/${item.id}/download`);
    if (tab) tab.location.href = url;
  }

  function downloadFolderZip(item: AdminFileItem) {
    window.open(`/api/v1/folders/${item.id}/download-zip`, "_blank");
  }

  function actionsFor(item: AdminFileItem): RowAction[] {
    return item.type === "folder"
      ? [{ label: "Download as ZIP", icon: Download, onSelect: () => downloadFolderZip(item) }]
      : [{ label: "Download", icon: Download, onSelect: () => downloadFile(item) }];
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {data?.folder && (
          <Button variant="ghost" size="sm" onClick={() => setFolderId(data.folder!.parentFolderId ?? undefined)} aria-label="Back">
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Button>
        )}
        <h1 className="text-xl font-semibold">{data?.folder ? data.folder.name : "User's files"}</h1>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">This folder has no files.</p>}

      {data && data.items.length > 0 && (
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
                        <button type="button" onClick={() => setFolderId(item.id)} className="font-medium hover:underline">
                          {item.name}
                        </button>
                      ) : (
                        <button type="button" onClick={() => setPreviewItem(item)} className="font-medium hover:underline">
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

      {previewItem && (
        <FilePreviewModal fileId={previewItem.id} name={previewItem.name} onClose={() => setPreviewItem(null)} />
      )}
    </div>
  );
}
