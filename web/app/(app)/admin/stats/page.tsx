"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Users as UsersIcon, HardDrive, Search, ChevronDown, Activity } from "lucide-react";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { RingChart } from "@/components/ui/ring-chart";

interface SystemStorage {
  totalStorageLimitBytes: number;
  totalStorageUsedBytes: number;
}

interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  storageUsedBytes: number;
  storageQuotaBytes: number;
}

interface ActivityEntry {
  id: string;
  createdAt: string;
}

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(2);
}

/** Searchable combobox for picking which user's ring chart to show — plain input + filtered
 * list rather than a full combobox library, matching this app's existing hand-rolled-popover
 * pattern (RowActionsMenu) instead of pulling in a new dependency for one picker. */
function UserPicker({
  users,
  selectedId,
  onSelect,
}: {
  users: AdminUserRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const selected = users.find((u) => u.id === selectedId);
  const filtered = users.filter((u) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  return (
    <div ref={containerRef} className="relative w-full max-w-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-muted/40"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={selected ? "font-medium" : "text-muted-foreground"}>
          {selected ? selected.displayName : "Select a user…"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-full overflow-hidden rounded-md border border-border bg-background shadow-lg">
          <div className="relative border-b border-border">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search users…"
              className="w-full bg-transparent py-2 pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul role="listbox" className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">No users match.</li>
            )}
            {filtered.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={u.id === selectedId}
                  onClick={() => {
                    onSelect(u.id);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <span className="font-medium">{u.displayName}</span>
                  <span className="text-xs text-muted-foreground">{u.email}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "Usage rate of the website" — a count of logged actions per day over the last 14 days, from
 * the same activity log the Activity page already lists. Client-side aggregation of data that's
 * already being fetched in full for that page, rather than a new time-series endpoint — the
 * lightest version of this that's still an honest number, not a fabricated growth curve. */
function ActivityRateChart() {
  const { data } = useQuery({
    queryKey: queryKeys.adminActivity(),
    queryFn: () => api.get<{ entries: ActivityEntry[] }>("/admin/activity"),
  });

  const days = React.useMemo(() => {
    const buckets: { label: string; count: number }[] = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      buckets.push({ label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), count: 0 });
    }
    const dayKey = (iso: string) => {
      const d = new Date(iso);
      const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
      return 13 - diffDays;
    };
    for (const entry of data?.entries ?? []) {
      const idx = dayKey(entry.createdAt);
      if (idx >= 0 && idx < buckets.length) buckets[idx].count += 1;
    }
    return buckets;
  }, [data]);

  const max = Math.max(1, ...days.map((d) => d.count));

  if (!data) return null;

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium">
        <Activity className="h-4 w-4 text-accent" aria-hidden />
        Site activity — last 14 days
      </div>
      <div className="flex h-24 items-end gap-1.5">
        {days.map((d, i) => (
          <div key={i} className="group relative flex-1">
            <div
              className="w-full rounded-t bg-accent/70 transition-colors group-hover:bg-accent"
              style={{ height: `${Math.max(4, Math.round((d.count / max) * 96))}px` }}
            />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[10px] text-background opacity-0 transition-opacity group-hover:opacity-100">
              {d.label}: {d.count}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Logged actions per day (uploads, shares, renames, etc.)</p>
    </div>
  );
}

export default function AdminStatsPage() {
  const { data: systemStorage } = useQuery({
    queryKey: queryKeys.adminSystemStorage(),
    queryFn: () => api.get<SystemStorage>("/admin/system-storage"),
  });
  const { data: usersData } = useQuery({
    queryKey: queryKeys.adminUsers(),
    queryFn: () => api.get<{ users: AdminUserRow[] }>("/admin/users"),
  });

  const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);
  const users = usersData?.users ?? [];
  const selectedUser = users.find((u) => u.id === selectedUserId) ?? null;

  const systemPercent =
    systemStorage && systemStorage.totalStorageLimitBytes > 0
      ? (systemStorage.totalStorageUsedBytes / systemStorage.totalStorageLimitBytes) * 100
      : 0;

  const userPercent =
    selectedUser && selectedUser.storageQuotaBytes > 0
      ? (selectedUser.storageUsedBytes / selectedUser.storageQuotaBytes) * 100
      : 0;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">System stats</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex items-center gap-3 rounded-lg border border-border p-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-accent">
            <UsersIcon className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <div className="text-2xl font-semibold">{users.length}</div>
            <div className="text-sm text-muted-foreground">Users</div>
          </div>
        </div>

        {systemStorage && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border p-4">
            <div className="flex items-center gap-2 self-start text-sm font-medium">
              <HardDrive className="h-4 w-4 text-accent" aria-hidden />
              System storage
            </div>
            <RingChart
              percent={systemPercent}
              size={128}
              strokeWidth={12}
              label={`${Math.round(systemPercent)}%`}
              sublabel={`${gb(systemStorage.totalStorageUsedBytes)} / ${gb(systemStorage.totalStorageLimitBytes)} GB`}
            />
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 text-sm font-medium">Storage usage per user</div>
        <UserPicker users={users} selectedId={selectedUserId} onSelect={setSelectedUserId} />

        {selectedUser && (
          <div className="mt-6 flex flex-col items-center gap-3">
            <RingChart
              percent={userPercent}
              size={160}
              strokeWidth={14}
              label={`${Math.round(userPercent)}%`}
              sublabel={`${gb(selectedUser.storageUsedBytes)} / ${gb(selectedUser.storageQuotaBytes)} GB`}
            />
            <div className="text-center">
              <div className="font-medium">{selectedUser.displayName}</div>
              <div className="text-xs text-muted-foreground">{selectedUser.email}</div>
            </div>
          </div>
        )}
        {!selectedUser && (
          <p className="mt-4 text-sm text-muted-foreground">Pick a user above to see their storage usage.</p>
        )}
      </div>

      <ActivityRateChart />
    </div>
  );
}
