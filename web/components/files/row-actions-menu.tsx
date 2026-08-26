"use client";

import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RowAction {
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  onSelect: () => void;
  destructive?: boolean;
}

// Deliberately hand-rolled rather than a Radix DropdownMenu: this codebase has no other Radix
// Portal usage, and @radix-ui/react-dropdown-menu's trigger reliably failed to open here (traced
// to something in this app's event handling, not narrowed further) — a plain click-outside popover
// sidesteps it entirely with the same look.
//
// The popup itself is `position: fixed`, placed from the trigger button's own getBoundingClientRect
// rather than CSS `absolute` inside a `relative` wrapper. Every place this renders (the file
// browser's list table, its grid cards, and anywhere else this is reused) sits inside a
// `rounded-lg overflow-hidden` container for its own visual corners, and a CSS-absolute popup is
// clipped by that ancestor the moment it would extend past its bounds — which is exactly the
// near-bottom rows (the ones you'd actually scroll to and use). `fixed` positioning is computed
// relative to the viewport, not any scrolling/clipping ancestor, so it escapes that entirely. It
// also flips to open upward when there isn't room below, for the same reason.
const MENU_EST_HEIGHT_PER_ACTION = 34;

export function RowActionsMenu({ actions }: { actions: RowAction[] }) {
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<{ top: number; left: number } | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest('[data-row-actions-menu="true"]')
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
    const menuHeight = actions.length * MENU_EST_HEIGHT_PER_ACTION + 8;
    const opensUpward = rect.bottom + menuHeight > window.innerHeight;
    setPosition({
      top: opensUpward ? rect.top - menuHeight : rect.bottom + 4,
      left: Math.max(8, rect.right - 144), // 144px = menu min-width, right-aligned to the trigger
    });
    setOpen(true);
  }

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={cn(
          "rounded-md p-1 text-muted-foreground opacity-100 transition-opacity hover:bg-muted hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100",
          open && "opacity-100 bg-muted",
        )}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
      {open && position && (
        <div
          role="menu"
          data-row-actions-menu="true"
          style={{ position: "fixed", top: position.top, left: position.left }}
          className="z-50 min-w-[9rem] overflow-hidden rounded-md border border-border bg-background p-1 text-foreground shadow-lg"
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
              className={cn(
                "flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus:bg-muted",
                action.destructive && "text-destructive",
              )}
            >
              <action.icon className="h-4 w-4" aria-hidden />
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
