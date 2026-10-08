"use client";

// Admin-only storage settings: the hard, system-wide cap on total storage across every account
// combined, and the quota newly registered accounts start with. The real enforcement of the cap
// lives in DB triggers (supabase/migrations/0015_system_storage_limit.sql, 0022) — this page is
// just the admin-facing view/edit surface for the numbers they read.

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
  totalStorageAllocatedBytes: number;
  defaultUserQuotaBytes: number;
}

/** One "number of GB + Save" form, kept in sync with the server value until the admin edits it. */
function GbSettingForm({
  id,
  label,
  currentBytes,
  save,
  fallbackError,
}: {
  id: string;
  label: string;
  currentBytes: number | undefined;
  save: (bytes: number) => Promise<void>;
  fallbackError: string;
}) {
  const [valueGb, setValueGb] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  // Only follow the fetched value until the admin starts editing — otherwise every background
  // refetch would stomp on whatever they're mid-typing.
  const [touched, setTouched] = React.useState(false);
  React.useEffect(() => {
    if (currentBytes !== undefined && !touched) setValueGb(formatGbInput(currentBytes));
  }, [currentBytes, touched]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const gb = Number(valueGb);
    if (valueGb.trim() === "" || !Number.isFinite(gb) || gb < 0) {
      setError("Enter a non-negative number of GB.");
      return;
    }
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await save(Math.round(gb * 1e9));
      setTouched(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallbackError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="number"
          min={0}
          step="any"
          value={valueGb}
          onChange={(e) => {
            setValueGb(e.target.value);
            setTouched(true);
            setSaved(false);
          }}
          className="max-w-[10rem]"
        />
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && !error && <p className="text-sm text-muted-foreground">Saved.</p>}
    </form>
  );
}

// Bytes → GB for an input field: at most two decimals, without trailing zeros ("15", "16.11").
function formatGbInput(bytes: number): string {
  return Number((bytes / 1e9).toFixed(2)).toString();
}

export default function AdminSystemStoragePage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminSystemStorage(),
    queryFn: () => api.get<SystemStorageSettings>("/admin/system-storage"),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.adminSystemStorage() });

  const usedGb = data ? data.totalStorageUsedBytes / 1e9 : 0;
  const limitGbCurrent = data ? data.totalStorageLimitBytes / 1e9 : 0;
  const allocatedGb = data ? data.totalStorageAllocatedBytes / 1e9 : 0;
  const unallocatedGb = Math.max(0, limitGbCurrent - allocatedGb);
  const allocatedPercent = data && data.totalStorageLimitBytes > 0
    ? Math.min(100, Math.round((data.totalStorageAllocatedBytes / data.totalStorageLimitBytes) * 100))
    : 0;
  const defaultGb = data ? data.defaultUserQuotaBytes / 1e9 : 0;
  // How many more accounts can register and verify before the system is fully allocated.
  const accountsLeft =
    data && data.defaultUserQuotaBytes > 0
      ? Math.floor(Math.max(0, data.totalStorageLimitBytes - data.totalStorageAllocatedBytes) / data.defaultUserQuotaBytes)
      : null;
  const percent = data && data.totalStorageLimitBytes > 0
    ? Math.min(100, Math.round((data.totalStorageUsedBytes / data.totalStorageLimitBytes) * 100))
    : 0;

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Storage settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A hard cap on total storage across every account combined. Enforced at the database
          level, not just here. A user&apos;s quota is pre-allocated out of this limit once they
          verify their email: verified quotas can never total more than it, and new registrations
          are refused once there isn&apos;t enough unallocated space left for another
          account&apos;s default quota.
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

          <div className="mb-2 mt-4 text-sm font-medium text-muted-foreground">Allocated to verified users&apos; quotas</div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full ${allocatedPercent >= 100 ? "bg-destructive" : "bg-accent"}`}
              style={{ width: `${allocatedPercent}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>{allocatedGb.toFixed(2)} GB allocated ({allocatedPercent}%)</span>
            <span>{unallocatedGb.toFixed(2)} GB unallocated</span>
          </div>
        </div>
      )}

      <GbSettingForm
        id="limit-gb"
        label="System storage limit (GB)"
        currentBytes={data?.totalStorageLimitBytes}
        save={async (bytes) => {
          await api.patch("/admin/system-storage", { totalStorageLimitBytes: bytes });
          await refresh();
        }}
        fallbackError="Could not update the storage limit."
      />

      <section className="space-y-3 border-t border-border pt-6">
        <div>
          <h2 className="text-lg font-semibold">Default quota for new users</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The storage every newly registered account starts with. Changing it only affects
            accounts created from now on — existing users keep their current quota, which you can
            change per user on the Users page. It can&apos;t be larger than the system limit.
          </p>
        </div>

        {data && (
          <p className="text-sm text-muted-foreground">
            Currently <span className="font-medium text-foreground">{defaultGb.toFixed(2)} GB</span> per new account
            {accountsLeft !== null && (
              <>
                {" "}— unallocated space is enough for{" "}
                <span className="font-medium text-foreground">{accountsLeft.toLocaleString()}</span> more
                {accountsLeft === 1 ? " account" : " accounts"} at this size
                {accountsLeft === 0 && ", so new registrations are currently refused"}
              </>
            )}
            .
          </p>
        )}

        <GbSettingForm
          id="default-quota-gb"
          label="Default quota (GB)"
          currentBytes={data?.defaultUserQuotaBytes}
          save={async (bytes) => {
            await api.patch("/admin/system-storage/default-quota", { defaultUserQuotaBytes: bytes });
            await refresh();
          }}
          fallbackError="Could not update the default quota."
        />
      </section>
    </div>
  );
}
