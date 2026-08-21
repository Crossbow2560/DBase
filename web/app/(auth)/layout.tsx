"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

// FRONTEND_DESIGN.md §4.1: redirects AWAY if already logged in. Client-side only (§4.1's
// "both gates run client-side" note) — an already-logged-in user briefly sees this layout's
// children render before AuthProvider resolves and this effect redirects them away. Accepted
// tradeoff, not a bug — see §4.1 for why server-side session checking wasn't adopted instead.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!isLoading && user) {
      router.replace("/folders");
    }
  }, [isLoading, user, router]);

  return <div className="flex min-h-screen items-center justify-center px-4">{children}</div>;
}
