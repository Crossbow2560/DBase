"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Folder, FileText, Eye, Pencil } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { FilePreviewModal } from "@/components/files/file-preview-modal";

interface SharedItem {
  id: string;
  name: string;
  type: "file" | "folder";
  role: "viewer" | "editor";
}

const ROLE_LABEL: Record<SharedItem["role"], string> = {
  viewer: "Viewer",
  editor: "Editor",
};

function RoleBadge({ role }: { role: SharedItem["role"] }) {
  const Icon = role === "editor" ? Pencil : Eye;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
      <Icon className="h-3 w-3" aria-hidden />
      {ROLE_LABEL[role]}
    </span>
  );
}

export default function SharedWithMePage() {
  const [previewItem, setPreviewItem] = React.useState<SharedItem | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.sharedWithMe(),
    queryFn: () => api.get<{ items: SharedItem[] }>("/shared-with-me"),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Shared with me</h1>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.items.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing shared with you yet.</p>
      )}

      {data && data.items.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="w-32 px-4 py-2.5 font-medium">Access</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.items.map((item) => (
                <tr key={item.id} className={cn("hover:bg-muted/30")}>
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
                  <td className="px-4 py-2.5 align-middle">
                    <RoleBadge role={item.role} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {previewItem && (
        <FilePreviewModal
          fileId={previewItem.id}
          name={previewItem.name}
          onClose={() => setPreviewItem(null)}
        />
      )}
    </div>
  );
}
