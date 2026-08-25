"use client";

import * as React from "react";

// Was a plain useState inside FolderBrowser — since that component is remounted on every folder
// navigation (a Next.js route change, not just a re-render: /folders/[folderId] is a different
// page per folder), the list/grid choice silently reset to "list" every time you clicked into a
// subfolder. Persisting to localStorage survives both the remount and a full page reload.
const STORAGE_KEY = "dbase:view-preference";

export type ViewPreference = "list" | "grid";

export function useViewPreference(): [ViewPreference, (view: ViewPreference) => void] {
  const [view, setViewState] = React.useState<ViewPreference>("list");

  // Reading localStorage during the initial render would mismatch the server-rendered HTML (SSR
  // has no localStorage) and trigger a hydration warning — this intentionally starts at the
  // default and corrects itself right after mount instead, same as any other
  // localStorage-backed preference.
  React.useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "list" || stored === "grid") setViewState(stored);
  }, []);

  const setView = React.useCallback((next: ViewPreference) => {
    setViewState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return [view, setView];
}
