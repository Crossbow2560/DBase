"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { FilePreviewModal } from "@/components/files/file-preview-modal";

interface SharedItem {
  id: string;
  name: string;
  type: "file" | "folder";
  role: "viewer" | "editor";
}

export default function SharedWithMePage() {
  const [previewItem, setPreviewItem] = React.useState<SharedItem | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.sharedWithMe(),
    queryFn: () => api.get<{ items: SharedItem[] }>("/shared-with-me"),
  });

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Shared with me</h1>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">Nothing shared with you yet.</p>}
      <ul className="divide-y divide-border rounded-md border border-border">
        {data?.items.map((item) => (
          <li key={item.id} className="flex items-center justify-between px-3 py-2 text-sm">
            {item.type === "folder" ? (
              <Link href={`/folders/${item.id}`} className="hover:underline">
                📁 {item.name}
              </Link>
            ) : (
              <button type="button" onClick={() => setPreviewItem(item)} className="hover:underline">
                📄 {item.name}
              </button>
            )}
            <span className="text-muted-foreground">{item.role}</span>
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
    </div>
  );
}
