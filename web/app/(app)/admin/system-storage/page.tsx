"use client";

// REQUIREMENTS-equivalent: a hard, system-wide cap on total storage across every account
// combined, admin-only. The real enforcement lives in a DB trigger
// (supabase/migrations/0015_system_storage_limit.sql) — this page is just the admin-facing
// view/edit surface for the one number that trigger reads.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SystemStorageSettings {
  totalStorageLimitBytes: number;
  totalStorageUsedBytes: number;
}

export default function AdminSystemStoragePage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminSystemStorage(),
    queryFn: () => api.get<SystemStorageSettings>("/admin/system-storage"),
  });

  const [limitGb, setLimitGb] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Keep the input in sync with the fetched value, but only until the admin starts editing —
  // otherwise every background refetch would stomp on whatever they're mid-typing.
  const [touched, setTouched] = React.useState(false);
  React.useEffect(() => {
    if (data && !touched) {
      setLimitGb((data.totalStorageLimitBytes / 1e9).toString());
    }
  }, [data, touched]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const gb = Number(limitGb);
    if (!Number.isFinite(gb) || gb < 0) {
      setError("Limit must be a non-negative number of GB.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api.patch("/admin/system-storage", { totalStorageLimitBytes: Math.round(gb * 1e9) });
      setTouched(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.adminSystemStorage() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the storage limit.");
    } finally {
      setSaving(false);
    }
  }

  const usedGb = data ? data.totalStorageUsedBytes / 1e9 : 0;
  const limitGbCurrent = data ? data.totalStorageLimitBytes / 1e9 : 0;
  const percent = data && data.totalStorageLimitBytes > 0
    ? Math.min(100, Math.round((data.totalStorageUsedBytes / data.totalStorageLimitBytes) * 100))
    : 0;

  return (
    <div className="max-w-lg space-y-4">
      <div>
        <h1 className="text-xl font-semibold">System storage limit</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A hard cap on total storage across every account combined. Enforced at the database
          level, not just here — no upload anywhere in the system can push total usage past this
          number.
        </p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && (
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <HardDrive className="h-4 w-4" aria-hidden />
            System-wide usage
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full ${percent >= 100 ? "bg-destructive" : "bg-accent"}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>{usedGb.toFixed(2)} GB used</span>
            <span>{limitGbCurrent.toFixed(0)} GB limit ({percent}%)</span>
          </div>
        </div>
      )}

      <form onSubmit={save} className="space-y-2">
        <label htmlFor="limit-gb" className="text-sm font-medium">
          New limit (GB)
        </label>
        <div className="flex gap-2">
          <Input
            id="limit-gb"
            type="number"
            min={0}
            step="1"
            value={limitGb}
            onChange={(e) => {
              setLimitGb(e.target.value);
              setTouched(true);
            }}
            className="max-w-[10rem]"
          />
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </form>
    </div>
  );
}
