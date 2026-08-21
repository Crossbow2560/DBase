"use client";

// Click-to-open inline preview, à la Google Drive — backed by GET /files/:id/preview
// (Subcomponent 1/filesystem module), which returns a presigned MinIO URL with
// Content-Disposition: inline and the file's real Content-Type (see storage/client.ts's
// getPresignedPreviewUrl), distinct from the Download button's attachment-disposition URL.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

interface PreviewResponse {
  available: boolean;
  url?: string;
  mimeType?: string;
}

export function FilePreviewModal({
  fileId,
  name,
  onClose,
}: {
  fileId: string;
  name: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["files", fileId, "preview"],
    queryFn: () => api.get<PreviewResponse>(`/files/${fileId}/preview`),
  });

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function download() {
    const tab = window.open("", "_blank");
    const { url } = await api.get<{ url: string }>(`/files/${fileId}/download`);
    if (tab) tab.location.href = url;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-md bg-background"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="truncate text-sm font-medium">{name}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={download}>
              Download
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              ✕
            </Button>
          </div>
        </div>

        <div className="flex min-h-[300px] flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
          {isLoading && <p className="text-sm text-muted-foreground">Loading preview…</p>}
          {!isLoading && !data?.available && (
            <p className="text-sm text-muted-foreground">No preview available for this file.</p>
          )}
          {data?.available && data.mimeType?.startsWith("image/") && (
            <img src={data.url} alt={name} className="max-h-[70vh] max-w-full object-contain" />
          )}
          {data?.available && data.mimeType?.startsWith("video/") && (
            <video src={data.url} controls autoPlay className="max-h-[70vh] max-w-full" />
          )}
          {data?.available && data.mimeType?.startsWith("audio/") && (
            <audio src={data.url} controls className="w-full max-w-md" />
          )}
          {data?.available && data.mimeType === "application/pdf" && (
            <iframe src={data.url} title={name} className="h-[75vh] w-full border-0" />
          )}
        </div>
      </div>
    </div>
  );
}
