"use client";

// Admin-triggered duplication of the entire MinIO object store into a separate, timestamped
// backup bucket (src/modules/storage/client.ts's backupBucket(), via
// src/modules/admin/backup-service.ts) — server-side copy, so no object bytes pass through this
// app or the browser.

import * as React from "react";
import { DatabaseBackup } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

interface BackupResult {
  backupBucket: string;
  objectCount: number;
}

export default function AdminBackupPage() {
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<BackupResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function runBackup() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const data = await api.post<BackupResult>("/admin/backup");
      setResult(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Backup failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="max-w-lg space-y-4">
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

      {error && <p className="text-sm text-destructive">{error}</p>}

      {result && (
        <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <DatabaseBackup className="h-4 w-4" aria-hidden />
            Backup complete
          </div>
          <p className="mt-1 text-muted-foreground">
            {result.objectCount} object{result.objectCount === 1 ? "" : "s"} copied to{" "}
            <code className="rounded bg-muted px-1 py-0.5">{result.backupBucket}</code>.
          </p>
        </div>
      )}
    </div>
  );
}
