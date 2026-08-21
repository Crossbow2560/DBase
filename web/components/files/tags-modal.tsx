"use client";

// REQUIREMENTS.md §5.8: apply/remove your own tags on a specific item — distinct from
// app/(app)/tags/page.tsx, which manages the tag definitions themselves.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Tag as TagIcon } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

interface Tag {
  id: string;
  name: string;
  color: string | null;
}

export function TagsModal({
  itemType,
  itemId,
  itemName,
  onClose,
}: {
  itemType: "file" | "folder";
  itemId: string;
  itemName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const itemTagsKey = ["items", itemType, itemId, "tags"] as const;

  const { data: allTags } = useQuery({
    queryKey: ["tags"],
    queryFn: () => api.get<{ tags: Tag[] }>("/tags"),
  });
  const { data: itemTags } = useQuery({
    queryKey: itemTagsKey,
    queryFn: () => api.get<{ tags: Tag[] }>(`/items/${itemType}/${itemId}/tags`),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: itemTagsKey });
  }

  async function applyTag(tagId: string) {
    await api.post(`/items/${itemType}/${itemId}/tags`, { tagId });
    invalidate();
  }

  async function removeTag(tagId: string) {
    await api.delete(`/items/${itemType}/${itemId}/tags/${tagId}`);
    invalidate();
  }

  const appliedIds = new Set(itemTags?.tags.map((t) => t.id));
  const availableTags = allTags?.tags.filter((t) => !appliedIds.has(t.id)) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-md bg-background p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Tags on &quot;{itemName}&quot;</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Applied</h3>
          {itemTags?.tags.length === 0 && <p className="text-sm text-muted-foreground">No tags applied.</p>}
          <ul className="divide-y divide-border rounded-md border border-border">
            {itemTags?.tags.map((tag) => (
              <li key={tag.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <TagIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {tag.name}
                </span>
                <Button variant="ghost" size="sm" onClick={() => removeTag(tag.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4 space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Your other tags</h3>
          {allTags && availableTags.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {allTags.tags.length === 0 ? (
                <>No tags created yet — manage tags from the Tags page.</>
              ) : (
                <>All of your tags are already applied.</>
              )}
            </p>
          )}
          <ul className="divide-y divide-border rounded-md border border-border">
            {availableTags.map((tag) => (
              <li key={tag.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <TagIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {tag.name}
                </span>
                <Button variant="ghost" size="sm" onClick={() => applyTag(tag.id)}>
                  Apply
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
