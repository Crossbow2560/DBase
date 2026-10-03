"use client";

// Bottom-right toast tray, per the owner decision resolving FRONTEND_DESIGN.md §8 item 2.
// Renders nothing when there are no uploads — not a persistent fixture. A folder upload is one
// row (combined progress and controls) rather than one row per file, so a folder of hundreds of
// files doesn't bury everything else.

import { FileText, Folder, X } from "lucide-react";
import { useUploads, type UploadGroup, type UploadTask } from "@/lib/uploads";
import { Button } from "@/components/ui/button";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-accent transition-all" style={{ width: `${percent}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right text-xs text-muted-foreground">{percent}%</span>
    </div>
  );
}

function CancelButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Cancel">
      <X className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

function FileRow({ task }: { task: UploadTask }) {
  const { pause, resume, cancel, dismiss } = useUploads();
  const percent = task.totalBytes > 0 ? Math.round((task.uploadedBytes / task.totalBytes) * 100) : 0;
  return (
    <div className="p-3">
      <div className="flex items-center gap-2 text-sm">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">{task.fileName}</span>
        {(task.status === "queued" || task.status === "uploading" || task.status === "paused") && (
          <CancelButton onClick={() => cancel(task.id)} />
        )}
      </div>

      {task.status !== "error" && <ProgressBar percent={percent} />}

      <div className="mt-1 text-xs text-muted-foreground">
        {task.status === "error" ? (
          task.error
        ) : task.status === "queued" ? (
          <>Queued — {formatBytes(task.totalBytes)}</>
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
}

function GroupRow({ group, tasks }: { group: UploadGroup; tasks: UploadTask[] }) {
  const { pauseGroup, resumeGroup, cancelGroup, dismissGroup } = useUploads();

  const count = (status: UploadTask["status"]) => tasks.filter((t) => t.status === status).length;
  const completed = count("complete");
  const failed = tasks.filter((t) => t.status === "error");
  const canceled = count("canceled");
  const active = count("queued") + count("uploading");
  const paused = count("paused");
  const uploadedBytes = tasks.reduce((sum, t) => sum + t.uploadedBytes, 0);
  const percent =
    group.totalBytes > 0
      ? Math.round((uploadedBytes / group.totalBytes) * 100)
      : group.totalFiles > 0
        ? Math.round((completed / group.totalFiles) * 100)
        : 100;
  const finished = group.phase === "failed" || (group.phase === "ready" && active === 0 && paused === 0);

  let detail: string;
  if (group.phase === "preparing") {
    detail = `Preparing — ${group.totalFiles} file${group.totalFiles === 1 ? "" : "s"}, ${group.folderCount} folder${group.folderCount === 1 ? "" : "s"}`;
  } else if (group.phase === "failed") {
    detail = group.error ?? "Could not upload this folder.";
  } else if (!finished) {
    detail = `${completed} of ${group.totalFiles} files · ${formatBytes(uploadedBytes)} of ${formatBytes(group.totalBytes)}${
      paused > 0 && active === 0 ? " · Paused" : ""
    }`;
  } else if (canceled > 0 && completed === 0) {
    detail = "Canceled";
  } else {
    detail = `${completed} of ${group.totalFiles} files uploaded${failed.length > 0 ? ` · ${failed.length} failed` : ""}${
      canceled > 0 ? ` · ${canceled} canceled` : ""
    }`;
  }

  return (
    <div className="p-3">
      <div className="flex items-center gap-2 text-sm">
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
        {!finished && group.phase === "ready" && <CancelButton onClick={() => cancelGroup(group.id)} />}
      </div>

      {group.phase !== "failed" && <ProgressBar percent={group.phase === "preparing" ? 0 : percent} />}

      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>

      {failed.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-destructive">
          {failed.slice(0, 3).map((t) => (
            <li key={t.id} className="truncate">
              {t.fileName}: {t.error}
            </li>
          ))}
          {failed.length > 3 && <li>and {failed.length - 3} more</li>}
        </ul>
      )}

      <div className="mt-2 flex gap-2">
        {group.phase === "ready" && active > 0 && (
          <Button size="sm" variant="outline" onClick={() => pauseGroup(group.id)}>
            Pause
          </Button>
        )}
        {group.phase === "ready" && paused > 0 && (
          <Button size="sm" variant="outline" onClick={() => resumeGroup(group.id)}>
            Resume
          </Button>
        )}
        {finished && (
          <Button size="sm" variant="ghost" onClick={() => dismissGroup(group.id)}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}

export function UploadTray() {
  const { uploads, groups } = useUploads();
  const ungrouped = uploads.filter((t) => !t.groupId);

  if (ungrouped.length === 0 && groups.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 overflow-hidden rounded-lg border border-border bg-background shadow-xl">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2 text-sm font-medium">
        Uploads ({groups.length + ungrouped.length})
      </div>
      <div className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto">
        {groups.map((group) => (
          <GroupRow key={group.id} group={group} tasks={uploads.filter((t) => t.groupId === group.id)} />
        ))}
        {ungrouped.map((task) => (
          <FileRow key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}
