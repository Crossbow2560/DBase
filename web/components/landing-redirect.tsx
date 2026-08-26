"use client";

// Split out of app/page.tsx so that page can be a Server Component (real markup in the initial
// HTML response for crawlers/scrapers, plus a page-specific <title>/description via `metadata` —
// neither is available from a "use client" page). This component renders nothing itself; it only
// runs the "already logged in? send them to /home" redirect, same client-side-only check
// (auth)/layout.tsx's mirror-image redirect uses, so it has to stay a client component regardless
// of what its parent is.
import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export function LandingRedirect() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!isLoading && user) {
      router.replace("/home");
    }
  }, [isLoading, user, router]);

  return null;
}
