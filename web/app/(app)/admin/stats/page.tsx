"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Users as UsersIcon, HardDrive, Search, ChevronDown, Activity } from "lucide-react";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { MultiRingChart } from "@/components/ui/multi-ring-chart";
import { CATEGORY_META, type StorageBreakdown } from "@/lib/storage-categories";

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
  action: string;
  createdAt: string;
}

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(2);
}

function breakdownSegments(breakdown: StorageBreakdown | undefined, totalBytes: number) {
  const categories = breakdown?.categories ?? [];
  return categories.map((c) => ({
    category: c.category,
    bytes: Number(c.bytes),
    percentOfTotal: totalBytes > 0 ? (Number(c.bytes) / totalBytes) * 100 : 0,
  }));
}

/** Same donut used by the per-user Storage Capacity card on the home page (MultiRingChart) —
 * here fed either the system-wide breakdown or one user's, so admin stats reads consistently
 * with what every user already sees for their own storage. */
function StorageDonut({
  breakdown,
  usedBytes,
  totalBytes,
  size,
  strokeWidth,
}: {
  breakdown: StorageBreakdown | undefined;
  usedBytes: number;
  totalBytes: number;
  size: number;
  strokeWidth: number;
}) {
  const percent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
  const segments = breakdownSegments(breakdown, totalBytes);

  return (
    <div className="flex flex-wrap items-center gap-6">
      <MultiRingChart
        size={size}
        strokeWidth={strokeWidth}
        centerLabel={`${percent}%`}
        centerSublabel="USED"
        segments={segments.map((s) => ({
          value: s.percentOfTotal,
          colorClassName: CATEGORY_META[s.category].textClass,
        }))}
      />
      <ul className="space-y-1.5">
        {segments.map((s) => (
          <li key={s.category} className="flex items-center gap-2 text-sm">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${CATEGORY_META[s.category].bgClass}`} aria-hidden />
            {CATEGORY_META[s.category].label}
            <span className="text-muted-foreground">{(s.bytes / 1e9).toFixed(2)} GB</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Searchable combobox for picking which user's donut to show — plain input + filtered list
 * rather than a full combobox library, matching this app's existing hand-rolled-popover pattern
 * (RowActionsMenu) instead of pulling in a new dependency for one picker. */
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

const WINDOW_DAYS = 14;

interface DayBucket {
  label: string;
  count: number;
}

/** Buckets a set of activity entries into one count per day over the last WINDOW_DAYS days —
 * shared by the overall chart and every per-operation chart below, each just handed a
 * differently-filtered slice of the same already-fetched entries list (no extra network calls
 * per operation group). */
function bucketByDay(entries: ActivityEntry[]): DayBucket[] {
  const buckets: DayBucket[] = [];
  const now = new Date();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    buckets.push({ label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), count: 0 });
  }
  const dayIndex = (iso: string) => {
    const d = new Date(iso);
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
    return WINDOW_DAYS - 1 - diffDays;
  };
  for (const entry of entries) {
    const idx = dayIndex(entry.createdAt);
    if (idx >= 0 && idx < buckets.length) buckets[idx].count += 1;
  }
  return buckets;
}

/** One bar chart with a y-axis (three tick labels: 0 / half / max) and an x-axis (every other
 * day's date, plus the last one, to keep 14 labels from overlapping), and the window's average
 * count/day alongside the title. Reused for the overall total and for each operation group below
 * rather than one-off markup per chart. */
function DayBarChart({
  title,
  icon: Icon,
  days,
  colorClassName = "bg-accent/70 group-hover:bg-accent",
}: {
  title: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  days: DayBucket[];
  colorClassName?: string;
}) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const total = days.reduce((sum, d) => sum + d.count, 0);
  const average = total / days.length;
  const yTicks = [max, Math.round(max / 2), 0];

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon className="h-4 w-4 text-accent" aria-hidden />
          {title}
        </div>
        <div className="text-xs text-muted-foreground">
          Avg <span className="font-medium text-foreground">{average.toFixed(1)}</span>/day
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <div className="flex h-24 flex-col justify-between pb-4 text-[10px] leading-none text-muted-foreground">
          {yTicks.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
        <div className="flex-1">
          <div className="flex h-24 items-end gap-1 border-l border-border pl-2">
            {days.map((d, i) => (
              <div key={i} className="group relative flex-1">
                <div
                  className={`w-full rounded-t transition-colors ${colorClassName}`}
                  style={{ height: `${Math.max(2, Math.round((d.count / max) * 96))}px` }}
                />
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[10px] text-background opacity-0 transition-opacity group-hover:opacity-100">
                  {d.label}: {d.count}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 flex gap-1 pl-2">
            {days.map((d, i) => (
              <div key={i} className="flex-1 text-center">
                {(i % 2 === 0 || i === days.length - 1) && (
                  <span className="text-[9px] text-muted-foreground">{d.label}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Groups the ~20 distinct activity_log action strings (upload, share, tag, ...) into a handful
 * of operation categories a chart-per-category can actually read as — one chart per raw action
 * would be 20 near-empty charts, not a more useful view. */
const OPERATION_GROUPS: { key: string; label: string; actions: string[] }[] = [
  { key: "uploads", label: "Uploads", actions: ["upload"] },
  { key: "downloads", label: "Downloads", actions: ["download"] },
  {
    key: "sharing",
    label: "Sharing",
    actions: ["share", "unshare", "create_share_link", "revoke_share_link", "ownership_transfer", "permission_change"],
  },
  { key: "organization", label: "Tags & favorites", actions: ["tag", "untag", "favorite", "unfavorite"] },
  { key: "deletions", label: "Deletions & restores", actions: ["delete", "purge", "restore"] },
  {
    key: "admin",
    label: "Admin & account",
    actions: [
      "view",
      "quota_change",
      "system_storage_limit_change",
      "account_deactivate",
      "account_reactivate",
      "account_delete",
    ],
  },
];

export default function AdminStatsPage() {
  const { data: systemStorage } = useQuery({
    queryKey: queryKeys.adminSystemStorage(),
    queryFn: () => api.get<SystemStorage>("/admin/system-storage"),
  });
  const { data: systemBreakdown } = useQuery({
    queryKey: queryKeys.adminSystemStorageBreakdown(),
    queryFn: () => api.get<StorageBreakdown>("/admin/system-storage-breakdown"),
  });
  const { data: usersData } = useQuery({
    queryKey: queryKeys.adminUsers(),
    queryFn: () => api.get<{ users: AdminUserRow[] }>("/admin/users"),
  });
  const { data: activityData } = useQuery({
    queryKey: queryKeys.adminActivity(),
    queryFn: () => api.get<{ entries: ActivityEntry[] }>("/admin/activity"),
  });

  const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);
  const users = usersData?.users ?? [];
  const selectedUser = users.find((u) => u.id === selectedUserId) ?? null;

  const { data: userBreakdown } = useQuery({
    queryKey: queryKeys.adminUserStorageBreakdown(selectedUserId ?? ""),
    queryFn: () => api.get<StorageBreakdown>(`/admin/users/${selectedUserId}/storage-breakdown`),
    enabled: !!selectedUserId,
  });

  const entries = activityData?.entries ?? [];
  const overallDays = React.useMemo(() => bucketByDay(entries), [entries]);
  const groupDays = React.useMemo(
    () =>
      OPERATION_GROUPS.map((group) => ({
        ...group,
        days: bucketByDay(entries.filter((e) => group.actions.includes(e.action))),
      })),
    [entries],
  );

  return (
    <div className="w-full space-y-6">
      <h1 className="text-xl font-semibold">System stats</h1>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex items-center gap-3 rounded-lg border border-border p-4 lg:col-span-1">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-accent">
            <UsersIcon className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <div className="text-2xl font-semibold">{users.length}</div>
            <div className="text-sm text-muted-foreground">Users</div>
          </div>
        </div>

        {systemStorage && (
          <div className="rounded-lg border border-border p-4 lg:col-span-2">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <HardDrive className="h-4 w-4 text-accent" aria-hidden />
                System storage
              </div>
              <div className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{gb(systemStorage.totalStorageUsedBytes)}</span> /{" "}
                {gb(systemStorage.totalStorageLimitBytes)} GB used system-wide
              </div>
            </div>
            <StorageDonut
              breakdown={systemBreakdown}
              usedBytes={systemStorage.totalStorageUsedBytes}
              totalBytes={systemStorage.totalStorageLimitBytes}
              size={140}
              strokeWidth={14}
            />
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 text-sm font-medium">Storage usage per user</div>
        <UserPicker users={users} selectedId={selectedUserId} onSelect={setSelectedUserId} />

        {selectedUser && (
          <div className="mt-6 space-y-3">
            <StorageDonut
              breakdown={userBreakdown}
              usedBytes={selectedUser.storageUsedBytes}
              totalBytes={selectedUser.storageQuotaBytes}
              size={160}
              strokeWidth={14}
            />
            <div>
              <div className="font-medium">{selectedUser.displayName}</div>
              <div className="text-xs text-muted-foreground">{selectedUser.email}</div>
            </div>
          </div>
        )}
        {!selectedUser && (
          <p className="mt-4 text-sm text-muted-foreground">Pick a user above to see their storage usage.</p>
        )}
      </div>

      {activityData && (
        <div className="space-y-4">
          <DayBarChart title="Site activity — last 14 days (all operations)" icon={Activity} days={overallDays} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {groupDays.map((group) => (
              <DayBarChart
                key={group.key}
                title={group.label}
                icon={Activity}
                days={group.days}
                colorClassName="bg-violet-400/70 group-hover:bg-violet-400"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
