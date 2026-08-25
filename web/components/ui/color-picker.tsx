"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const PRESET_COLORS = [
  "#4A7FA7", // accent blue — matches the app's own theme accent
  "#ef4444", // red
  "#f59e0b", // amber
  "#10b981", // emerald
  "#0ea5e9", // sky
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#64748b", // slate
];

export function ColorPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(null)}
        title="No color"
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/40 text-muted-foreground transition-transform hover:scale-110",
          value === null && "ring-2 ring-accent ring-offset-2 ring-offset-background",
        )}
      >
        {value === null && <Check className="h-3 w-3" aria-hidden />}
      </button>
      {PRESET_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          title={color}
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110",
            value === color && "ring-2 ring-accent ring-offset-2 ring-offset-background",
          )}
          style={{ backgroundColor: color }}
        >
          {value === color && <Check className="h-3 w-3 text-white" aria-hidden />}
        </button>
      ))}
      <label
        className="relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border transition-transform hover:scale-110"
        style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}
        title="Custom color"
      >
        <input
          type="color"
          value={value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#4a7fa7"}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label="Custom color"
        />
      </label>
    </div>
  );
}
