"use client";

// REQUIREMENTS.md §5.8 — manage your own personal tag definitions. Applying a tag to a specific
// file/folder happens from the file browser's Tags button (components/files/tags-modal.tsx),
// not here; this page only owns create/list/delete of the tags themselves.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Tag {
  id: string;
  name: string;
  color: string | null;
}

export default function TagsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["tags"],
    queryFn: () => api.get<{ tags: Tag[] }>("/tags"),
  });

  async function createTag(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      await api.post("/tags", { name });
      setName("");
      queryClient.invalidateQueries({ queryKey: ["tags"] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create tag.");
    }
  }

  async function deleteTag(tag: Tag) {
    await api.delete(`/tags/${tag.id}`);
    queryClient.invalidateQueries({ queryKey: ["tags"] });
  }

  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-xl font-semibold">Tags</h1>
      <p className="text-sm text-muted-foreground">
        Personal labels — only you can see or apply your tags, even on items you don&apos;t own.
      </p>

      <form onSubmit={createTag} className="flex gap-2">
        <Input placeholder="New tag name" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
        <Button type="submit">Create</Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.tags.length === 0 && <p className="text-sm text-muted-foreground">No tags yet.</p>}
      <ul className="divide-y divide-border rounded-md border border-border">
        {data?.tags.map((tag) => (
          <li key={tag.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <span>🏷️ {tag.name}</span>
            <Button variant="ghost" size="sm" onClick={() => deleteTag(tag)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
