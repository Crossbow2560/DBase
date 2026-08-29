"use client";

// A small custom dropdown for a single-choice value (sort key, type filter, etc.) — hand-rolled
// for the same reason row-actions-menu.tsx is: a native <select> renders its open popup with the
// OS's own styling (system font, blue highlight, square corners on Windows), which reads as a
// jarring foreign element dropped into this app's actual theme. This mirrors row-actions-menu's
// fixed-position, click-outside-to-close popover so the open state looks like the rest of the UI
// in both themes, not like a browser control.
import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
}

const MENU_EST_HEIGHT_PER_OPTION = 34;

export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  icon: Icon,
  ariaLabel,
  className,
}: {
  value: T;
  options: SelectMenuOption<T>[];
  onChange: (value: T) => void;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const selected = options.find((o) => o.value === value);

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest('[data-select-menu="true"]')
      ) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function openMenu() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = options.length * MENU_EST_HEIGHT_PER_OPTION + 8;
    const opensUpward = rect.bottom + menuHeight > window.innerHeight;
    setPosition({
      top: opensUpward ? rect.top - menuHeight : rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 160),
    });
    setOpen(true);
  }

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-sm text-foreground hover:bg-muted",
          open && "bg-muted",
          className,
        )}
      >
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="whitespace-nowrap">{selected?.label ?? ariaLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open && position && (
        <div
          role="listbox"
          data-select-menu="true"
          style={{ position: "fixed", top: position.top, left: position.left, minWidth: position.width }}
          className="z-50 overflow-hidden rounded-md border border-border bg-background p-1 text-foreground shadow-lg"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                setOpen(false);
                onChange(option.value);
              }}
              className={cn(
                "flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus:bg-muted",
                option.value === value && "font-medium",
              )}
            >
              {option.label}
              {option.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
