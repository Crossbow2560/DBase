"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

// FRONTEND_DESIGN.md §4.1: admin's own role check, separate from (app)'s auth gate — still
// requires a normal session (nested inside (app)), just adds role==='admin'.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!isLoading && user && user.role !== "admin") {
      router.replace("/folders");
    }
  }, [isLoading, user, router]);

  if (isLoading || !user || user.role !== "admin") {
    return null;
  }

  return <div className="space-y-4">{children}</div>;
}
