"use client";

import * as React from "react";

// Same SSR-safe localStorage pattern as use-view-preference.ts: starts at the default and
// corrects itself right after mount (reading localStorage during the initial render would
// mismatch server-rendered HTML and trigger a hydration warning). The actual first-paint flash
// this would otherwise cause is avoided separately — see the inline script in app/layout.tsx,
// which sets the `data-theme` attribute before React ever hydrates. This hook's job is just to
// keep React's own idea of the current theme in sync with that attribute, and to let anything
// that calls setTheme() change it.
//
// "alt" (amber) is the app's default now — an unset/missing localStorage key means alt, and
// only an explicit "default" opt-out switches back to the original blue theme. The stored value
// name "default" is kept as-is (not renamed to "classic" or similar) purely so existing
// localStorage entries from before this switch keep meaning what they already meant.
const STORAGE_KEY = "dbase:theme";

export type Theme = "default" | "alt";

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = React.useState<Theme>("alt");

  React.useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "default") setThemeState("default");
  }, []);

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    if (next === "default") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", next);
    }
  }, []);

  return [theme, setTheme];
}
