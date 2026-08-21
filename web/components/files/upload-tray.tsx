"use client";

// Bottom-right toast tray, per the owner decision resolving FRONTEND_DESIGN.md §8 item 2.
// Renders nothing when there are no uploads — not a persistent fixture.

import { useUploads } from "@/lib/uploads";
import { Button } from "@/components/ui/button";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function UploadTray() {
  const { uploads, pause, resume, cancel, dismiss } = useUploads();

  if (uploads.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {uploads.map((task) => {
        const percent = task.totalBytes > 0 ? Math.round((task.uploadedBytes / task.totalBytes) * 100) : 0;
        return (
          <div key={task.id} className="rounded-lg border border-border bg-background p-3 shadow-lg">
            <div className="flex items-center justify-between text-sm">
              <span className="truncate font-medium">{task.fileName}</span>
              <span className="ml-2 shrink-0 text-muted-foreground">
                {task.status === "error" ? "Failed" : `${percent}%`}
              </span>
            </div>

            {task.status !== "error" && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
            )}

            <div className="mt-1 text-xs text-muted-foreground">
              {task.status === "error" ? (
                task.error
              ) : (
                <>
                  {formatBytes(task.uploadedBytes)} / {formatBytes(task.totalBytes)}
                </>
              )}
            </div>

            <div className="mt-2 flex gap-2">
              {task.status === "uploading" && (
                <Button size="sm" variant="outline" onClick={() => pause(task.id)}>
                  Pause
                </Button>
              )}
              {task.status === "paused" && (
                <Button size="sm" variant="outline" onClick={() => resume(task.id)}>
                  Resume
                </Button>
              )}
              {(task.status === "uploading" || task.status === "paused") && (
                <Button size="sm" variant="destructive" onClick={() => cancel(task.id)}>
                  Cancel
                </Button>
              )}
              {(task.status === "complete" || task.status === "canceled" || task.status === "error") && (
                <Button size="sm" variant="ghost" onClick={() => dismiss(task.id)}>
                  Dismiss
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
