"use client";

// Bottom-right toast tray, per the owner decision resolving FRONTEND_DESIGN.md §8 item 2.
// Renders nothing when there are no uploads — not a persistent fixture.

import { FileText, X } from "lucide-react";
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
    <div className="fixed bottom-4 right-4 z-50 w-80 overflow-hidden rounded-lg border border-border bg-background shadow-xl">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2 text-sm font-medium">
        Uploads ({uploads.length})
      </div>
      <div className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto">
        {uploads.map((task) => {
          const percent = task.totalBytes > 0 ? Math.round((task.uploadedBytes / task.totalBytes) * 100) : 0;
          return (
            <div key={task.id} className="p-3">
              <div className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">{task.fileName}</span>
                {(task.status === "uploading" || task.status === "paused") && (
                  <button
                    type="button"
                    onClick={() => cancel(task.id)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="Cancel"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>

              {task.status !== "error" && (
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-accent transition-all" style={{ width: `${percent}%` }} />
                  </div>
                  <span className="w-9 shrink-0 text-right text-xs text-muted-foreground">{percent}%</span>
                </div>
              )}

              <div className="mt-1 text-xs text-muted-foreground">
                {task.status === "error" ? (
                  task.error
                ) : (
                  <>
                    {formatBytes(task.uploadedBytes)} of {formatBytes(task.totalBytes)}
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
    </div>
  );
}
