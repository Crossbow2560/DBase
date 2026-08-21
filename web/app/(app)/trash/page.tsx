"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, FileText, RotateCcw, Trash2, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
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

  // "Delete forever" doesn't purge synchronously — it only enqueues the item into a background
  // deletion queue a worker drains roughly once a minute (src/modules/trash/deletion-queue-service.ts).
  // Refetching /trash right after used to show the exact same list, since the row is still
  // sitting there with deleted_at set until the worker actually processes it — the button looked
  // like it did nothing (found by actually clicking it and watching the list not change). Once
  // the enqueue request itself succeeds, permanent deletion is guaranteed to happen — so this
  // page tracks purged ids locally and hides them immediately rather than waiting on the worker
  // to catch up and a refetch to reflect that.
  const [purgedIds, setPurgedIds] = React.useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = React.useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = React.useState<Record<string, string>>({});
  const [emptyingTrash, setEmptyingTrash] = React.useState(false);

  const visibleItems = data?.items.filter((item) => !purgedIds.has(item.id)) ?? [];

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.trash() });
  }

  function setPending(id: string, isPending: boolean) {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (isPending) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function setRowError(id: string, message: string | null) {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });
  }

  async function restore(item: TrashedItem) {
    setPending(item.id, true);
    setRowError(item.id, null);
    try {
      await api.post(`/trash/${item.type}/${item.id}/restore`);
      invalidate();
    } catch (err) {
      setRowError(item.id, err instanceof ApiError ? err.message : "Could not restore this item.");
    } finally {
      setPending(item.id, false);
    }
  }

  async function purge(item: TrashedItem) {
    setPending(item.id, true);
    setRowError(item.id, null);
    try {
      await api.delete(`/trash/${item.type}/${item.id}`);
      // Enqueue confirmed — this item is now guaranteed to be permanently deleted, so it's safe
      // to remove it from view immediately instead of waiting on the worker + a stale refetch.
      setPurgedIds((prev) => new Set(prev).add(item.id));
    } catch (err) {
      setRowError(item.id, err instanceof ApiError ? err.message : "Could not delete this item.");
      setPending(item.id, false);
    }
  }

  async function emptyTrash() {
    if (!data || data.items.length === 0) return;
    if (!confirm(`Permanently delete all ${data.items.length} item(s) in trash? This cannot be undone.`)) return;
    setEmptyingTrash(true);
    const results = await Promise.allSettled(
      data.items.map((item) => api.delete(`/trash/${item.type}/${item.id}`)),
    );
    const succeededIds = data.items.filter((_, i) => results[i].status === "fulfilled").map((item) => item.id);
    setPurgedIds((prev) => {
      const next = new Set(prev);
      succeededIds.forEach((id) => next.add(id));
      return next;
    });
    const failedCount = results.filter((r) => r.status === "rejected").length;
    if (failedCount > 0) {
      alert(`${failedCount} item(s) could not be deleted. They're still in trash — try again.`);
    }
    setEmptyingTrash(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Trash</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Items are permanently deleted 30 days after being trashed.
          </p>
        </div>
        {visibleItems.length > 0 && (
          <Button variant="destructive" size="sm" onClick={emptyTrash} disabled={emptyingTrash}>
            {emptyingTrash ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            Empty trash
          </Button>
        )}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && visibleItems.length === 0 && <p className="text-sm text-muted-foreground">Trash is empty.</p>}

      {visibleItems.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleItems.map((item) => {
                const isPending = pendingIds.has(item.id) || emptyingTrash;
                return (
                  <tr key={item.id} className="hover:bg-muted/30">
                    <td className="px-4 py-2.5 align-middle">
                      <div className="flex items-center gap-2.5">
                        {item.type === "folder" ? (
                          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        ) : (
                          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <span className="font-medium">{item.name}</span>
                      </div>
                      {rowErrors[item.id] && (
                        <p className="mt-1 text-xs text-destructive">{rowErrors[item.id]}</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5 align-middle">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => restore(item)} disabled={isPending}>
                          {pendingIds.has(item.id) ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                          )}
                          Restore
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => purge(item)} disabled={isPending}>
                          {pendingIds.has(item.id) ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                          )}
                          <span className="hidden sm:inline">Delete forever</span>
                          <span className="sm:hidden">Delete</span>
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
