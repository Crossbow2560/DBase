"use client";

import * as React from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function RenameModal({
  itemType,
  itemId,
  currentName,
  onClose,
  onRenamed,
}: {
  itemType: "file" | "folder";
  itemId: string;
  currentName: string;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = React.useState(currentName);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || name === currentName) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.patch(itemType === "folder" ? `/folders/${itemId}` : `/files/${itemId}`, { name });
      onRenamed();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not rename.");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-3 rounded-md bg-background p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold">Rename</h2>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            Rename
          </Button>
        </div>
      </form>
    </div>
  );
}
