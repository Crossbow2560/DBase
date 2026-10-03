"use client";

// A dashboard-style landing tab, separate from /folders (the full sortable browser with
// checkboxes/bulk actions/columns) — added alongside it rather than replacing it, per explicit
// direction. Shows the root folder's contents as a quick-glance "Folders" + "Recent Files"
// summary with a drag-and-drop upload zone, and links out to /folders for the full view.

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { UploadCloud, Folder, FileText, Image as ImageIcon, FileSpreadsheet, File as FileIcon } from "lucide-react";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useUploads } from "@/lib/uploads";
import { collectDroppedItems, collectFromDirectoryInput, isIgnoredFile } from "@/lib/folder-upload";
import { useAuth } from "@/lib/auth";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { MultiRingChart } from "@/components/ui/multi-ring-chart";
import { CATEGORY_META, type StorageBreakdown } from "@/lib/storage-categories";

interface StorageUsage {
  storageUsedBytes: string;
  storageQuotaBytes: string;
}

function StorageCapacityCard() {
  const { data: usage } = useQuery({
    queryKey: queryKeys.storageUsage(),
    queryFn: () => api.get<StorageUsage>("/users/me/storage"),
  });
  const { data: breakdown } = useQuery({
    queryKey: ["users", "me", "storage-breakdown"],
    queryFn: () => api.get<StorageBreakdown>("/users/me/storage-breakdown"),
  });

  if (!usage || !breakdown) return null;

  const used = Number(usage.storageUsedBytes);
  const quota = Number(usage.storageQuotaBytes);
  const percentUsed = quota > 0 ? Math.round((used / quota) * 100) : 0;

  const segments = breakdown.categories.map((c) => ({
    category: c.category,
    bytes: Number(c.bytes),
    percentOfQuota: quota > 0 ? (Number(c.bytes) / quota) * 100 : 0,
  }));

  return (
    <div className="flex flex-wrap items-center gap-8 rounded-xl border border-border p-6">
      <MultiRingChart
        size={140}
        strokeWidth={14}
        centerLabel={`${percentUsed}%`}
        centerSublabel="USED"
        segments={segments.map((s) => ({
          value: s.percentOfQuota,
          colorClassName: CATEGORY_META[s.category].textClass,
        }))}
      />
      <div className="min-w-[12rem] flex-1 space-y-3">
        <h2 className="text-lg font-semibold">Storage Capacity</h2>
        <ul className="space-y-2">
          {segments.map((s) => (
            <li key={s.category} className="flex items-center justify-between gap-4 text-sm">
              <span className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${CATEGORY_META[s.category].bgClass}`} aria-hidden />
                {CATEGORY_META[s.category].label}
              </span>
              <span className="text-muted-foreground">{(s.bytes / 1e9).toFixed(1)} GB</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface HomeItem {
  id: string;
  name: string;
  type: "file" | "folder";
  sizeBytes?: string;
  mimeType?: string;
  updatedAt: string;
}

// GET /files/recent: newest files anywhere under My Files, with where each one lives.
interface RecentFile extends HomeItem {
  createdAt: string;
  parentFolderId: string | null;
  location: { id: string; name: string }[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// "Added …" for a file that hasn't changed since upload, "Updated …" once it has (renamed, moved).
function formatRecency(file: RecentFile): string {
  const changed = new Date(file.updatedAt).getTime() - new Date(file.createdAt).getTime() > 1000;
  return formatAddedAt(file.updatedAt).replace(/^Added/, changed ? "Updated" : "Added");
}

function formatAddedAt(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return `Added today, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  if (isYesterday) return "Added yesterday";
  return `Added ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

const FOLDER_COLORS = [
  { bg: "bg-blue-100", fg: "text-blue-600" },
  { bg: "bg-rose-100", fg: "text-rose-600" },
  { bg: "bg-emerald-100", fg: "text-emerald-600" },
  { bg: "bg-amber-100", fg: "text-amber-600" },
  { bg: "bg-purple-100", fg: "text-purple-600" },
];

function fileTypeMeta(mimeType: string | undefined) {
  if (mimeType?.startsWith("image/")) {
    return { label: "Image", icon: ImageIcon, bg: "bg-purple-100", fg: "text-purple-600" };
  }
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "text/csv"
  ) {
    return { label: "Spreadsheet", icon: FileSpreadsheet, bg: "bg-emerald-100", fg: "text-emerald-600" };
  }
  if (mimeType === "application/pdf") {
    return { label: "PDF", icon: FileText, bg: "bg-blue-100", fg: "text-blue-600" };
  }
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword"
  ) {
    return { label: "Document", icon: FileText, bg: "bg-indigo-100", fg: "text-indigo-600" };
  }
  return { label: "File", icon: FileIcon, bg: "bg-muted", fg: "text-muted-foreground" };
}

/** Per-folder item count, fetched separately (same N+1-per-card tradeoff folder-browser.tsx's
 * FileThumbnail already accepts) — the root listing endpoint returns folders bare, with no
 * child count, so this is the only way to show one without a backend change. */
function FolderCard({ folder, colorIndex }: { folder: HomeItem; colorIndex: number }) {
  const { data } = useQuery({
    queryKey: queryKeys.folderContents(folder.id),
    queryFn: () => api.get<{ items: HomeItem[] }>(`/folders/${folder.id}/contents`),
    staleTime: 60_000,
  });
  const color = FOLDER_COLORS[colorIndex % FOLDER_COLORS.length];

  return (
    <Link
      href={`/folders/${folder.id}`}
      className="rounded-xl border border-border p-4 transition-colors hover:bg-muted/30"
    >
      <div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-lg ${color.bg}`}>
        <Folder className={`h-5 w-5 ${color.fg}`} aria-hidden />
      </div>
      <div className="truncate font-medium">{folder.name}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        {data ? `${data.items.length} item${data.items.length === 1 ? "" : "s"}` : " "}
      </div>
    </Link>
  );
}

export default function HomePage() {
  const { user } = useAuth();
  const { startUpload, startFolderUpload } = useUploads();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const folderInputRef = React.useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const [previewFile, setPreviewFile] = React.useState<HomeItem | null>(null);

  // From the server, across every subfolder — it used to be the root folder's own files sorted by
  // date, so anything uploaded into a folder never showed up here.
  const { data: recentData } = useQuery({
    queryKey: queryKeys.recentFiles(),
    queryFn: () => api.get<{ items: RecentFile[] }>("/files/recent?limit=6"),
  });
  const recentFiles = recentData?.items ?? [];

  const { data } = useQuery({
    queryKey: queryKeys.folderContents(null),
    queryFn: () => api.get<{ items: HomeItem[] }>("/folders/contents"),
  });

  const folders = data?.items.filter((i) => i.type === "folder") ?? [];
  const files = data?.items.filter((i) => i.type === "file") ?? [];

  function handleFiles(fileList: FileList | null) {
    if (!fileList) return;
    for (const file of Array.from(fileList)) {
      if (!isIgnoredFile(file.name)) startUpload(file, null);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">My Files</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Welcome back{user?.displayName ? `, ${user.displayName.split(" ")[0]}` : ""} — {files.length} file
          {files.length === 1 ? "" : "s"} and {folders.length} folder{folders.length === 1 ? "" : "s"} here.
        </p>
      </div>

      <StorageCapacityCard />

      <div
        role="button"
        tabIndex={0}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          // Not e.dataTransfer.files: that lists a dropped folder as a bogus 0-byte "file". The
          // items API tells folders apart, and folders upload with their whole structure.
          void collectDroppedItems(e.dataTransfer).then(({ looseFiles, folders }) => {
            for (const file of looseFiles) startUpload(file, null);
            if (folders) void startFolderUpload(folders, null);
          });
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-12 text-center transition-colors ${
          isDragOver ? "border-accent bg-accent/5" : "border-border hover:bg-muted/20"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={(el) => {
            folderInputRef.current = el;
            el?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const selection = e.target.files ? collectFromDirectoryInput(e.target.files) : null;
            if (selection) void startFolderUpload(selection, null);
            e.target.value = "";
          }}
        />
        <UploadCloud className="h-8 w-8 text-accent" aria-hidden />
        <div className="font-medium text-accent">Drop files or folders here to upload</div>
        <div className="text-sm text-muted-foreground">
          or click to browse from your computer, or{" "}
          <button
            type="button"
            className="font-medium text-accent underline-offset-2 hover:underline"
            onClick={(e) => {
              e.stopPropagation(); // the whole drop zone is itself a click-to-browse-files button
              folderInputRef.current?.click();
            }}
            onKeyDown={(e) => e.stopPropagation()} // keep Enter/Space from also opening the file picker
          >
            upload a folder
          </button>
        </div>
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Folders</h2>
        </div>
        {folders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No folders yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {folders.map((folder, i) => (
              <FolderCard key={folder.id} folder={folder} colorIndex={i} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent Files</h2>
          <Link href="/folders" className="text-sm font-medium text-accent hover:underline">
            View all
          </Link>
        </div>
        {recentFiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No files yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {recentFiles.map((file) => {
              const meta = fileTypeMeta(file.mimeType);
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => setPreviewFile(file)}
                  className="flex items-start gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:bg-muted/30"
                >
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${meta.bg}`}>
                    <meta.icon className={`h-5 w-5 ${meta.fg}`} aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{file.name}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs">
                      <span
                        className={`rounded-full px-2 py-0.5 font-medium ${meta.bg} ${meta.fg}`}
                      >
                        {meta.label}
                      </span>
                      {file.sizeBytes && (
                        <span className="text-muted-foreground">{formatBytes(Number(file.sizeBytes))}</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{formatRecency(file)}</div>
                    {file.location.length > 0 && (
                      <div
                        className="mt-0.5 truncate text-xs text-muted-foreground"
                        title={file.location.map((l) => l.name).join(" / ")}
                      >
                        in {file.location.map((l) => l.name).join(" / ")}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {previewFile && (
        <FilePreviewModal fileId={previewFile.id} name={previewFile.name} onClose={() => setPreviewFile(null)} />
      )}
    </div>
  );
}
