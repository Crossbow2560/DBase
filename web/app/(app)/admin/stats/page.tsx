"use client";

// Was two bare number tiles with no visual breakdown at all — "stats should show graphs",
// reported directly. Rather than inventing time-series data this app doesn't track anywhere,
// the graph here is a real, honest one: per-user storage usage, sourced from the same
// GET /admin/users data the Users page already lists (no new backend needed).

import { useQuery } from "@tanstack/react-query";
import { Users as UsersIcon, HardDrive, BarChart3 } from "lucide-react";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

interface AdminStats {
  totalUsers: number;
  totalStorageUsedBytes: number;
}

interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  storageUsedBytes: number;
  storageQuotaBytes: number;
}

const BAR_COLORS = ["bg-accent", "bg-blue-400", "bg-emerald-400", "bg-amber-400", "bg-rose-400", "bg-purple-400"];

export default function AdminStatsPage() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminStats(),
    queryFn: () => api.get<AdminStats>("/admin/stats"),
  });
  const { data: usersData } = useQuery({
    queryKey: queryKeys.adminUsers(),
    queryFn: () => api.get<{ users: AdminUserRow[] }>("/admin/users"),
  });

  const sortedUsers = [...(usersData?.users ?? [])].sort((a, b) => b.storageUsedBytes - a.storageUsedBytes);
  const maxUsedBytes = Math.max(1, ...sortedUsers.map((u) => u.storageUsedBytes));

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">System stats</h1>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && (
        <div className="grid grid-cols-2 gap-4">
          <div className="flex items-center gap-3 rounded-lg border border-border p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-accent">
              <UsersIcon className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <div className="text-2xl font-semibold">{data.totalUsers}</div>
              <div className="text-sm text-muted-foreground">Users</div>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-border p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-accent">
              <HardDrive className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <div className="text-2xl font-semibold">{(data.totalStorageUsedBytes / 1e9).toFixed(2)} GB</div>
              {/* DESIGN.md §3.10: an approximation, excludes in-flight uploads/pending deletions. */}
              <div className="text-sm text-muted-foreground">Total storage (approximate)</div>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border p-4">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium">
          <BarChart3 className="h-4 w-4 text-accent" aria-hidden />
          Storage by user
        </div>

        {sortedUsers.length === 0 && <p className="text-sm text-muted-foreground">No users yet.</p>}

        <div className="space-y-3">
          {sortedUsers.map((u, i) => {
            const percentOfMax = Math.max(2, Math.round((u.storageUsedBytes / maxUsedBytes) * 100));
            const percentOfOwnQuota =
              u.storageQuotaBytes > 0 ? Math.min(100, Math.round((u.storageUsedBytes / u.storageQuotaBytes) * 100)) : 0;
            return (
              <div key={u.id}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium">{u.displayName}</span>
                  <span className="text-muted-foreground">
                    {(u.storageUsedBytes / 1e9).toFixed(2)} / {(u.storageQuotaBytes / 1e9).toFixed(0)} GB (
                    {percentOfOwnQuota}%)
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${BAR_COLORS[i % BAR_COLORS.length]}`}
                    style={{ width: `${percentOfMax}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
