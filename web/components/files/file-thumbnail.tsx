"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Enlarged thumbnail for grid view only — list view always shows the plain file icon, never a
 * thumbnail, so scanning a long list stays fast and visually uniform.
 * REQUIREMENTS.md §5.9: "no preview available" is a normal state, not an error — this just falls
 * back to the plain file icon whenever the endpoint reports unavailable (not thumbnailable,
 * still generating, or failed), same as while loading.
 */
export function FileThumbnail({ fileId }: { fileId: string }) {
  const { data } = useQuery({
    queryKey: queryKeys.thumbnail(fileId),
    queryFn: () => api.get<{ available: boolean; url?: string }>(`/files/${fileId}/thumbnail`),
    staleTime: 60_000,
  });

  if (data?.available && data.url) {
    return <img src={data.url} alt="" className="h-full w-full object-cover" />;
  }
  return <FileText className="h-8 w-8 text-muted-foreground" aria-hidden />;
}
