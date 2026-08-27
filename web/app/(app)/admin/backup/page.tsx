"use client";

// Admin-triggered duplication of the entire MinIO object store into a separate, timestamped
// backup bucket (src/modules/storage/client.ts's backupBucket(), via
// src/modules/admin/backup-service.ts) — server-side copy, so no object bytes pass through this
// app or the browser. Restoring works the same way, in reverse, back into the live bucket.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, Loader2, RotateCcw } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";

interface BackupRunResult {
  backupBucket: string;
  objectCount: number;
}

interface Backup {
  name: string;
  createdAt: string;
}

export default function AdminBackupPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminBackups(),
    queryFn: () => api.get<{ backups: Backup[] }>("/admin/backups"),
  });

  const [running, setRunning] = React.useState(false);
  const [runResult, setRunResult] = React.useState<BackupRunResult | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);

  async function runBackup() {
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      const result = await api.post<BackupRunResult>("/admin/backup");
      setRunResult(result);
      queryClient.invalidateQueries({ queryKey: queryKeys.adminBackups() });
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Backup failed.");
    } finally {
      setRunning(false);
    }
  }

  // The picked-for-restore backup, held separately from the list so the confirmation modal below
  // still has something to render its own error into after a restore attempt fails.
  const [restoringBackup, setRestoringBackup] = React.useState<Backup | null>(null);
  const [isRestoring, setIsRestoring] = React.useState(false);
  const [restoreError, setRestoreError] = React.useState<string | null>(null);
  const [lastRestored, setLastRestored] = React.useState<{ name: string; objectCount: number } | null>(null);

  async function confirmRestore() {
    if (!restoringBackup) return;
    setIsRestoring(true);
    setRestoreError(null);
    try {
      const result = await api.post<{ objectCount: number }>(
        `/admin/backups/${encodeURIComponent(restoringBackup.name)}/restore`,
      );
      setLastRestored({ name: restoringBackup.name, objectCount: result.objectCount });
      setRestoringBackup(null);
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : "Restore failed.");
    } finally {
      setIsRestoring(false);
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Backup</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Duplicates every object currently in storage into a new, timestamped backup bucket in
          MinIO. Runs as a server-side copy, so it doesn&apos;t re-upload any data — safe to run
          on a large store, though it may take a while to complete for one.
        </p>
      </div>

      <Button onClick={runBackup} disabled={running}>
        {running ? "Backing up…" : "Run backup now"}
      </Button>

      {runError && <p className="text-sm text-destructive">{runError}</p>}

      {runResult && (
        <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <DatabaseBackup className="h-4 w-4" aria-hidden />
            Backup complete
          </div>
          <p className="mt-1 text-muted-foreground">
            {runResult.objectCount} object{runResult.objectCount === 1 ? "" : "s"} copied to{" "}
            <code className="rounded bg-muted px-1 py-0.5">{runResult.backupBucket}</code>.
          </p>
        </div>
      )}

      <div className="space-y-2 border-t border-border pt-4">
        <h2 className="text-sm font-semibold">Restore from backup</h2>
        <p className="text-sm text-muted-foreground">
          Copies a chosen backup&apos;s objects back into live storage, overwriting whatever
          currently sits at each key. Files created since that backup was taken are left alone —
          this doesn&apos;t delete anything, only restores.
        </p>

        {isLoading && <p className="text-sm text-muted-foreground">Loading backups…</p>}
        {data && data.backups.length === 0 && (
          <p className="text-sm text-muted-foreground">No backups yet — run one above first.</p>
        )}

        {data && data.backups.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {data.backups.map((backup) => (
              <li key={backup.name} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs">{backup.name}</div>
                  <div className="text-muted-foreground">{new Date(backup.createdAt).toLocaleString()}</div>
                </div>
                <Button variant="outline" size="sm" onClick={() => setRestoringBackup(backup)}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}

        {lastRestored && (
          <p className="text-sm text-muted-foreground">
            Restored {lastRestored.objectCount} object{lastRestored.objectCount === 1 ? "" : "s"} from{" "}
            <code className="rounded bg-muted px-1 py-0.5">{lastRestored.name}</code>.
          </p>
        )}
      </div>

      {restoringBackup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => !isRestoring && setRestoringBackup(null)}
        >
          <div className="w-full max-w-sm space-y-3 rounded-md bg-background p-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold">Restore backup</h2>
            <p className="text-sm text-muted-foreground">
              Restore <code className="rounded bg-muted px-1 py-0.5">{restoringBackup.name}</code>? This
              overwrites any current object that also exists in this backup with the backed-up
              version. This cannot be undone.
            </p>
            {restoreError && <p className="text-sm text-destructive">{restoreError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRestoringBackup(null)} disabled={isRestoring}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={confirmRestore} disabled={isRestoring}>
                {isRestoring ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                Restore
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
