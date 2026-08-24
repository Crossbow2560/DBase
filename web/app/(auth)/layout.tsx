"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

// FRONTEND_DESIGN.md §4.1: redirects AWAY if already logged in. Client-side only (§4.1's
// "both gates run client-side" note) — an already-logged-in user briefly sees this layout's
// children render before AuthProvider resolves and this effect redirects them away. Accepted
// tradeoff, not a bug — see §4.1 for why server-side session checking wasn't adopted instead.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    // Was "/folders" — stale since /home (the actual post-login dashboard, per "/"'s own
    // already-logged-in redirect a few lines over in app/page.tsx) was added; this was the one
    // place that never got updated to match, so logging in landed you one level into the file
    // browser instead of the dashboard.
    if (!isLoading && user) {
      router.replace("/home");
    }
  }, [isLoading, user, router]);

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-32 -left-24 h-96 w-96 rounded-full bg-[#B3CFE5]/40 blur-3xl" />
        <div className="absolute top-1/2 -right-24 h-80 w-80 rounded-full bg-[#4A7FA7]/15 blur-3xl" />
      </div>

      {/* Same navbar as the public landing page ("/") — clicking the logo takes you back there,
          since that's the natural "back" destination from an auth page for a logged-out visitor
          (the authenticated /home dashboard isn't reachable yet at this point). */}
      <header className="relative border-b border-border/60 px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-foreground">
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
            </div>
            <span className="text-sm font-semibold">DBase</span>
          </Link>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">Log in</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/register">Sign up</Link>
            </Button>
          </div>
        </div>
      </header>

      <div className="relative flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full">{children}</div>
      </div>
    </div>
  );
}
