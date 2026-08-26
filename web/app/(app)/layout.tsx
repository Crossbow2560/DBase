"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Home,
  LayoutGrid,
  Users,
  Star,
  Trash2,
  Search,
  Tag,
  Laptop,
  Settings,
  UserCog,
  BarChart3,
  History,
  Cloud,
  HardDrive,
  Menu,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { UploadProvider } from "@/lib/uploads";
import { UploadTray } from "@/components/files/upload-tray";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

interface StorageUsage {
  storageUsedBytes: string;
  storageQuotaBytes: string;
}

function QuotaIndicator() {
  const { data } = useQuery({
    queryKey: queryKeys.storageUsage(),
    queryFn: () => api.get<StorageUsage>("/users/me/storage"),
  });

  if (!data) return null;

  const used = Number(data.storageUsedBytes);
  const quota = Number(data.storageQuotaBytes);
  const percent = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-[var(--sb-quota-pad)]">
      <div
        className="mb-[var(--sb-item-gap)] flex items-center gap-2 text-[length:var(--sb-item-text)] font-medium leading-none text-muted-foreground"
      >
        <Cloud className="h-[var(--sb-icon)] w-[var(--sb-icon)] shrink-0" aria-hidden /> Storage Quota
      </div>
      <div className="w-full overflow-hidden rounded-full bg-muted" style={{ height: "var(--sb-bar-h)" }}>
        <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <div
        className="flex items-center justify-between text-[length:var(--sb-item-text)] leading-none text-muted-foreground"
        style={{ marginTop: "var(--sb-item-gap)" }}
      >
        <span>{(used / 1e9).toFixed(1)} GB used</span>
        <span>{(quota / 1e9).toFixed(0)} GB</span>
      </div>
    </div>
  );
}

const NAV_LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/folders", label: "My Files", icon: LayoutGrid },
  { href: "/shared-with-me", label: "Shared with me", icon: Users },
  { href: "/favorites", label: "Favorites", icon: Star },
  { href: "/trash", label: "Trash", icon: Trash2 },
];

const SECONDARY_LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/search", label: "Search", icon: Search },
  { href: "/tags", label: "Tags", icon: Tag },
  { href: "/settings/sessions", label: "Devices", icon: Laptop },
  { href: "/settings/account", label: "Account", icon: Settings },
];

const ADMIN_LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/admin/users", label: "Users", icon: UserCog },
  { href: "/admin/stats", label: "Stats", icon: BarChart3 },
  { href: "/admin/activity", label: "Activity", icon: History },
  { href: "/admin/system-storage", label: "Storage Limit", icon: HardDrive },
];

// FRONTEND_DESIGN.md §4.1: redirects TO /login if not authenticated. Same client-side-only
// caveat as (auth)/layout.tsx — this app's pages briefly render before the redirect fires.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading, refetch } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  React.useEffect(() => {
    if (!isLoading && !user) {
      router.replace("/login");
    }
  }, [isLoading, user, router]);

  // Below md, the sidebar is an off-canvas drawer (see the <aside> className below) rather than
  // always-visible — at a phone width it would otherwise occupy the entire screen and leave no
  // room for content at all (confirmed by hand: a 375px-wide viewport rendered the sidebar edge
  // to edge with the actual page pushed off-screen). Closing it on every route change means
  // tapping a nav link takes you to the page instead of leaving the drawer open over it.
  React.useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  async function handleLogout() {
    await api.post("/auth/logout");
    // No router.replace() here — same fix and same reasoning as (auth)/login/page.tsx's
    // comment: without this refetch, the cached `user` from before logout stays truthy, so
    // this layout's own effect above never fires (it only redirects on !user), leaving the UI
    // stuck showing the authenticated shell despite the session actually being revoked
    // server-side. refetch() hits /auth/me, gets 401, and api-client's UNAUTHENTICATED handler
    // (registered by AuthProvider) clears the cached user — which is what makes the effect
    // above finally see !user and redirect.
    await refetch();
  }

  if (isLoading || !user) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <UploadProvider>
      <div className="flex min-h-screen">
        {mobileNavOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden
          />
        )}

        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex h-screen w-64 shrink-0 flex-col overflow-y-hidden border-r border-border bg-background p-[var(--sb-pad)] transition-transform duration-200 ease-in-out",
            "md:sticky md:top-0 md:translate-x-0",
            mobileNavOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-[var(--sb-logo-mb)] flex shrink-0 items-center gap-2.5 px-1">
              <img
                src="/logo.png"
                alt=""
                className="shrink-0 object-contain"
                style={{ height: "var(--sb-logo-icon)", width: "var(--sb-logo-icon)" }}
              />
              <div>
                <div className="text-base font-extrabold font-semibold leading-tight">DBase</div>
              </div>
            </div>

            {/* The three nav lists stack with a capped gap between them — not flex-1/stretched,
                just their own natural height. Any leftover vertical space in the sidebar now
                collects below this block (inside the flex-1 wrapper it sits in) rather than
                being distributed as ever-larger gaps here or pinning the account block right
                underneath it — that's what pushes the account block down to the very bottom
                below, instead of it trailing right after ADMINISTRATION with the empty room
                stuck in between the two. */}
            <div className="flex flex-col" style={{ gap: "var(--sb-group-gap)" }}>
            <nav className="flex flex-col" style={{ gap: "var(--sb-item-gap)" }}>
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileNavOpen(false)}
                  className="flex items-center gap-2.5 rounded-md text-[length:var(--sb-item-text)] leading-none text-foreground/90 hover:bg-muted"
                  style={{ paddingInline: "var(--sb-item-px)", paddingBlock: "var(--sb-item-py)" }}
                >
                  <link.icon className="h-[var(--sb-icon)] w-[var(--sb-icon)] shrink-0" aria-hidden />
                  {link.label}
                </Link>
              ))}
            </nav>

            <nav
              className="flex flex-col border-t border-border"
              style={{ gap: "var(--sb-item-gap)", marginTop: "var(--sb-section-mt)", paddingTop: "var(--sb-section-pt)" }}
            >
              {SECONDARY_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileNavOpen(false)}
                  className="flex items-center gap-2.5 rounded-md text-[length:var(--sb-item-text)] leading-none text-foreground/90 hover:bg-muted"
                  style={{ paddingInline: "var(--sb-item-px)", paddingBlock: "var(--sb-item-py)" }}
                >
                  <link.icon className="h-[var(--sb-icon)] w-[var(--sb-icon)] shrink-0" aria-hidden />
                  {link.label}
                </Link>
              ))}
            </nav>

            {user.role === "admin" && (
              <nav
                className="flex flex-col border-t border-border"
                style={{ gap: "var(--sb-item-gap)", marginTop: "var(--sb-section-mt)", paddingTop: "var(--sb-section-pt)" }}
              >
                <div className="px-[var(--sb-item-px)] pb-[var(--sb-item-gap)] text-xs font-semibold leading-none tracking-wide text-muted-foreground">
                  ADMINISTRATION
                </div>
                {ADMIN_LINKS.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMobileNavOpen(false)}
                    className="flex items-center gap-2.5 rounded-md text-[length:var(--sb-item-text)] leading-none text-foreground/90 hover:bg-muted"
                    style={{ paddingInline: "var(--sb-item-px)", paddingBlock: "var(--sb-item-py)" }}
                  >
                    <link.icon className="h-[var(--sb-icon)] w-[var(--sb-icon)] shrink-0" aria-hidden />
                    {link.label}
                  </Link>
                ))}
              </nav>
            )}

            </div>
          </div>

          {/* Pinned to the very bottom of the sidebar — a sibling of the flex-1 wrapper above,
              not nested inside it, so whatever room the nav lists don't use collects here as a
              gap above this block rather than right after ADMINISTRATION. */}
          <div className="flex shrink-0 flex-col" style={{ gap: "var(--sb-block-gap)" }}>
            <QuotaIndicator />
            <div
              className="flex items-center gap-2 border-t border-border text-sm"
              style={{ paddingTop: "var(--sb-block-gap)" }}
            >
              <div
                className="flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
                style={{ height: "var(--sb-avatar)", width: "var(--sb-avatar)" }}
              >
                {user.displayName?.[0]?.toUpperCase() ?? "?"}
              </div>
              <div className="min-w-0 flex-1 leading-none">
                <div className="truncate font-medium">{user.displayName}</div>
                <div className="mt-[var(--sb-item-gap)] truncate text-xs text-muted-foreground">{user.email}</div>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
              className="w-full shrink-0"
              style={{ height: "var(--sb-logout-h)" }}
            >
              Log out
            </Button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:hidden">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open menu"
              className="rounded-md p-1.5 text-foreground hover:bg-muted"
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="" className="h-11 w-11 shrink-0 object-contain" />
              <span className="text-sm font-semibold">DBase</span>
            </div>
          </div>
          <main className="flex-1 overflow-x-auto p-4 sm:p-5">{children}</main>
        </div>
        <UploadTray />
      </div>
    </UploadProvider>
  );
}
