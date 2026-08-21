"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, FileText, Star } from "lucide-react";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
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
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Favorites</h1>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">No favorites yet.</p>}

      {data && data.items.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Name</th>
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
                    </div>
                  </td>
                  <td className="px-4 py-2.5 align-middle">
                    <button
                      type="button"
                      onClick={() => unfavorite(item)}
                      title="Remove from favorites"
                      className="text-accent opacity-100 transition-opacity hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
                    >
                      <Star className="h-4 w-4" fill="currentColor" aria-hidden />
                    </button>
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
