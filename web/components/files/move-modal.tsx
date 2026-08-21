"use client";

// A minimal folder picker: navigate via the same folder-contents endpoint the main browser
// uses, filtered to subfolders only, with a "Move here" action at whatever level you've
// navigated to. The backend already rejects moving a folder into itself/its own descendants
// (CYCLE_DETECTED) and enforces editor-or-above on both the item and the destination — this
// component just surfaces whatever error that produces rather than re-validating client-side.

import * as React from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

interface FolderOption {
  id: string;
  name: string;
  type: "file" | "folder";
}

export function MoveModal({
  itemType,
  itemId,
  itemName,
  onClose,
  onMoved,
}: {
  itemType: "file" | "folder";
  itemId: string;
  itemName: string;
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

  async function moveHere() {
    setError(null);
    try {
      const body = itemType === "folder" ? { parentFolderId: currentFolderId } : { folderId: currentFolderId };
      await api.patch(itemType === "folder" ? `/folders/${itemId}` : `/files/${itemId}`, body);
      onMoved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not move here.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-sm space-y-3 rounded-md bg-background p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">Move &quot;{itemName}&quot;</h2>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Currently browsing: {currentFolderName}</span>
          {currentFolderId && (
            <button type="button" className="hover:underline" onClick={() => { setCurrentFolderId(null); setCurrentFolderName("My Files"); }}>
              ⤴ Root
            </button>
          )}
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        <ul className="max-h-64 divide-y divide-border overflow-auto rounded-md border border-border">
          {!isLoading && subfolders.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">No subfolders here.</li>
          )}
          {subfolders
            .filter((f) => !(itemType === "folder" && f.id === itemId))
            .map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setCurrentFolderId(folder.id);
                    setCurrentFolderName(folder.name);
                  }}
                >
                  📁 {folder.name}
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
