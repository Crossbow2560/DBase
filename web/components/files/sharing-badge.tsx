"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * Was a hardcoded "Private" string for every row regardless of actual state — reported directly
 * ("after sharing file tag does not change"). Same per-row-query tradeoff as FileThumbnail: two
 * small queries per row rather than a bulk endpoint, since none exists for "sharing summary
 * across many items" and these lists are typically small enough for it not to matter.
 */
export function SharingBadge({ itemType, itemId }: { itemType: "file" | "folder"; itemId: string }) {
  const { data: collaborators } = useQuery({
    queryKey: ["items", itemType, itemId, "permissions"],
    queryFn: () => api.get<{ collaborators: unknown[] }>(`/items/${itemType}/${itemId}/permissions`),
    staleTime: 30_000,
  });
  const { data: links } = useQuery({
    queryKey: ["items", itemType, itemId, "share-links"],
    queryFn: () => api.get<{ links: unknown[] }>(`/items/${itemType}/${itemId}/share-links`),
    staleTime: 30_000,
  });

  const isShared = (collaborators?.collaborators.length ?? 0) > 0 || (links?.links.length ?? 0) > 0;
  return <>{isShared ? "Shared" : "Private"}</>;
}
