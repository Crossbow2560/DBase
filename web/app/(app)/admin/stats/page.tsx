"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

interface AdminStats {
  totalUsers: number;
  totalStorageUsedBytes: number;
}

export default function AdminStatsPage() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminStats(),
    queryFn: () => api.get<AdminStats>("/admin/stats"),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">System stats</h1>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && (
        <div className="grid max-w-md grid-cols-2 gap-4">
          <div className="rounded-md border border-border p-4">
            <div className="text-2xl font-semibold">{data.totalUsers}</div>
            <div className="text-sm text-muted-foreground">Users</div>
          </div>
          <div className="rounded-md border border-border p-4">
            <div className="text-2xl font-semibold">{(data.totalStorageUsedBytes / 1e9).toFixed(2)} GB</div>
            {/* DESIGN.md §3.10: an approximation, excludes in-flight uploads/pending deletions. */}
            <div className="text-sm text-muted-foreground">Total storage (approximate)</div>
          </div>
        </div>
      )}
    </div>
  );
}
