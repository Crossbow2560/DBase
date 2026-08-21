"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { FilePreviewModal } from "@/components/files/file-preview-modal";

interface FavoriteItem {
  id: string;
  name: string;
  type: "file" | "folder";
}

export default function FavoritesPage() {
  const queryClient = useQueryClient();
  const [previewItem, setPreviewItem] = React.useState<FavoriteItem | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.favorites(),
    queryFn: () => api.get<{ items: FavoriteItem[] }>("/favorites"),
  });

  async function unfavorite(item: FavoriteItem) {
    await api.delete(`/items/${item.type}/${item.id}/favorite`);
    queryClient.invalidateQueries({ queryKey: queryKeys.favorites() });
  }

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Favorites</h1>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">No favorites yet.</p>}
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
            <Button variant="ghost" size="sm" onClick={() => unfavorite(item)}>
              ★ Remove
            </Button>
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
