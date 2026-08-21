"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { UploadProvider } from "@/lib/uploads";
import { UploadTray } from "@/components/files/upload-tray";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";

interface StorageUsage {
  storageUsedBytes: string;
  storageQuotaBytes: string;
}

function QuotaIndicator() {
  const { data } = useQuery({
    queryKey: ["users", "me", "storage"],
    queryFn: () => api.get<StorageUsage>("/users/me/storage"),
  });

  if (!data) return null;

  const used = Number(data.storageUsedBytes);
  const quota = Number(data.storageQuotaBytes);
  const percent = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;

  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <div className="text-xs">
        {(used / 1e9).toFixed(2)} / {(quota / 1e9).toFixed(2)} GB used
      </div>
    </div>
  );
}

const NAV_LINKS = [
  { href: "/folders", label: "My Files" },
  { href: "/search", label: "Search" },
  { href: "/shared-with-me", label: "Shared with me" },
  { href: "/favorites", label: "Favorites" },
  { href: "/tags", label: "Tags" },
  { href: "/trash", label: "Trash" },
  { href: "/settings/sessions", label: "Devices" },
  { href: "/settings/account", label: "Account" },
];

// FRONTEND_DESIGN.md §4.1: redirects TO /login if not authenticated. Same client-side-only
// caveat as (auth)/layout.tsx — this app's pages briefly render before the redirect fires.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading, refetch } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!isLoading && !user) {
      router.replace("/login");
    }
  }, [isLoading, user, router]);

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
        <aside className="w-56 shrink-0 border-r border-border p-4">
          <div className="mb-6 font-semibold">DBase</div>
          <nav className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                {link.label}
              </Link>
            ))}
            {user.role === "admin" && (
              <Link href="/admin/users" className="rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                Admin
              </Link>
            )}
          </nav>
          {/* REQUIREMENTS.md §5.6 / FRONTEND_DESIGN.md §4.2's shell-layout note. Backed by
              GET /users/me/storage (APPLICATION_DESIGN.md §4.2) — a deliberately separate route
              from /auth/me, see that endpoint's doc comment for why. */}
          <div className="mt-4 border-t border-border pt-4">
            <QuotaIndicator />
          </div>
          <div className="mt-4 space-y-2 border-t border-border pt-4 text-sm text-muted-foreground">
            <div>{user.displayName}</div>
            <div className="truncate">{user.email}</div>
            <Button variant="outline" size="sm" onClick={handleLogout} className="w-full">
              Log out
            </Button>
          </div>
        </aside>
        <main className="flex-1 p-6">{children}</main>
        <UploadTray />
      </div>
    </UploadProvider>
  );
}
