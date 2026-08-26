"use client";

import { Palette } from "lucide-react";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";

const THEME_LABEL = { default: "Classic", alt: "Amber" } as const;

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();

  return (
    <button
      type="button"
      onClick={() => setTheme(theme === "default" ? "alt" : "default")}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-sm text-foreground/90 hover:bg-muted",
      )}
      title="Switch color theme"
    >
      <span className="flex items-center gap-2.5">
        <Palette className="h-4 w-4 shrink-0" aria-hidden />
        Theme
      </span>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {THEME_LABEL[theme]}
        <span
          className={cn("h-3 w-3 rounded-full border border-border", theme === "alt" ? "bg-accent" : "bg-primary")}
          aria-hidden
        />
      </span>
    </button>
  );
}
