"use client";

// A minimal folder picker: navigate via the same folder-contents endpoint the main browser
// uses, filtered to subfolders only, with a "Move here" action at whatever level you've
// navigated to. The backend already rejects moving a folder into itself/its own descendants
// (CYCLE_DETECTED) and enforces editor-or-above on both the item and the destination — this
// component just surfaces whatever error that produces rather than re-validating client-side.

import * as React from "react";
import { ArrowUp, Folder as FolderIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

interface FolderOption {
  id: string;
  name: string;
  type: "file" | "folder";
}

export interface MoveTarget {
  id: string;
  type: "file" | "folder";
}

export function MoveModal({
  items,
  label,
  onClose,
  onMoved,
}: {
  items: MoveTarget[];
  label: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const [currentFolderId, setCurrentFolderId] = React.useState<string | null>(null);
  const [currentFolderName, setCurrentFolderName] = React.useState("My Files");
  const [subfolders, setSubfolders] = React.useState<FolderOption[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setIsLoading(true);
    api
      .get<{ items: FolderOption[] }>(currentFolderId ? `/folders/${currentFolderId}/contents` : "/folders/contents")
      .then((res) => setSubfolders(res.items.filter((i) => i.type === "folder")))
      .finally(() => setIsLoading(false));
  }, [currentFolderId]);

  // A folder being moved can't be moved into itself — filters out every selected folder, not
  // just a single one, so this holds for a bulk move too.
  const movedFolderIds = new Set(items.filter((i) => i.type === "folder").map((i) => i.id));

  async function moveHere() {
    setError(null);
    try {
      await Promise.all(
        items.map((item) =>
          api.patch(
            item.type === "folder" ? `/folders/${item.id}` : `/files/${item.id}`,
            item.type === "folder" ? { parentFolderId: currentFolderId } : { folderId: currentFolderId },
          ),
        ),
      );
      onMoved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not move here.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-sm space-y-3 rounded-md bg-background p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">Move {label}</h2>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Currently browsing: {currentFolderName}</span>
          {currentFolderId && (
            <button
              type="button"
              className="flex items-center gap-1 hover:underline"
              onClick={() => {
                setCurrentFolderId(null);
                setCurrentFolderName("My Files");
              }}
            >
              <ArrowUp className="h-3 w-3" aria-hidden />
              Root
            </button>
          )}
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        <ul className="max-h-64 divide-y divide-border overflow-auto rounded-md border border-border">
          {!isLoading && subfolders.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">No subfolders here.</li>
          )}
          {subfolders
            .filter((f) => !movedFolderIds.has(f.id))
            .map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setCurrentFolderId(folder.id);
                    setCurrentFolderName(folder.name);
                  }}
                >
                  <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  {folder.name}
                </button>
              </li>
            ))}
        </ul>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={moveHere}>
            Move here
          </Button>
        </div>
      </div>
    </div>
  );
}
