"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";

interface TrashedItem {
  id: string;
  name: string;
  type: "file" | "folder";
  deletedAt: string;
}

export default function TrashPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.trash(),
    queryFn: () => api.get<{ items: TrashedItem[] }>("/trash"),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.trash() });
  }

  async function restore(item: TrashedItem) {
    await api.post(`/trash/${item.type}/${item.id}/restore`);
    invalidate();
  }

  async function purge(item: TrashedItem) {
    await api.delete(`/trash/${item.type}/${item.id}`);
    invalidate();
  }

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Trash</h1>
      <p className="text-sm text-muted-foreground">
        Items are permanently deleted 30 days after being trashed (REQUIREMENTS.md §5.4).
      </p>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">Trash is empty.</p>}
      <ul className="divide-y divide-border rounded-md border border-border">
        {data?.items.map((item) => (
          <li key={item.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <span>
              {item.type === "folder" ? "📁" : "📄"} {item.name}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => restore(item)}>
                Restore
              </Button>
              <Button variant="destructive" size="sm" onClick={() => purge(item)}>
                Delete forever
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
