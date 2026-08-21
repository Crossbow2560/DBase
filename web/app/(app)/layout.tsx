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
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Cloud className="h-3.5 w-3.5" aria-hidden /> Storage Quota
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
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
            "fixed inset-y-0 left-0 z-50 flex h-screen w-64 shrink-0 flex-col justify-between overflow-y-auto border-r border-border bg-background p-4 transition-transform duration-200 ease-in-out",
            "md:sticky md:top-0 md:translate-x-0",
            mobileNavOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div>
            <div className="mb-6 flex items-center gap-2.5 px-1">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <LayoutGrid className="h-4 w-4" aria-hidden />
              </div>
              <div>
                <div className="text-sm font-semibold leading-tight">DBase</div>
                <div className="text-xs leading-tight text-muted-foreground">Enterprise Storage</div>
              </div>
            </div>

            <nav className="flex flex-col gap-0.5">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileNavOpen(false)}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground/90 hover:bg-muted"
                >
                  <link.icon className="h-4 w-4 shrink-0" aria-hidden />
                  {link.label}
                </Link>
              ))}
            </nav>

            <nav className="mt-4 flex flex-col gap-0.5 border-t border-border pt-4">
              {SECONDARY_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileNavOpen(false)}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground/90 hover:bg-muted"
                >
                  <link.icon className="h-4 w-4 shrink-0" aria-hidden />
                  {link.label}
                </Link>
              ))}
            </nav>

            {user.role === "admin" && (
              <nav className="mt-4 flex flex-col gap-0.5 border-t border-border pt-4">
                <div className="px-2.5 pb-1 text-xs font-semibold tracking-wide text-muted-foreground">
                  ADMINISTRATION
                </div>
                {ADMIN_LINKS.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMobileNavOpen(false)}
                    className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground/90 hover:bg-muted"
                  >
                    <link.icon className="h-4 w-4 shrink-0" aria-hidden />
                    {link.label}
                  </Link>
                ))}
              </nav>
            )}
          </div>

          <div className="space-y-3">
            {/* REQUIREMENTS.md §5.6 / FRONTEND_DESIGN.md §4.2's shell-layout note. Backed by
                GET /users/me/storage (APPLICATION_DESIGN.md §4.2) — a deliberately separate route
                from /auth/me, see that endpoint's doc comment for why. */}
            <QuotaIndicator />
            <div className="flex items-center gap-2 border-t border-border pt-3 text-sm">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                {user.displayName?.[0]?.toUpperCase() ?? "?"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{user.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">{user.email}</div>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleLogout} className="w-full">
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
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
              </div>
              <span className="text-sm font-semibold">DBase</span>
            </div>
          </div>
          <main className="flex-1 overflow-x-auto p-4 sm:p-6">{children}</main>
        </div>
        <UploadTray />
      </div>
    </UploadProvider>
  );
}
