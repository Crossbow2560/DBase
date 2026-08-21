"use client";

// FRONTEND_DESIGN.md §6.2: populated once via GET /auth/me. This is the ONLY auth-check
// mechanism this app has — client-side, resolved after mount (§4.1's route-group rationale
// explicitly accepts the resulting flash-of-wrong-content on /login|/register as a deliberate
// tradeoff, not an oversight).

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, registerUnauthenticatedHandler } from "./api-client";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
}

interface AuthContextValue {
  user: CurrentUser | null;
  isLoading: boolean;
  refetch: () => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api.get<{ user: CurrentUser }>("/auth/me").then((r) => r.user),
    retry: false,
    // A 401 here means "not logged in", not a transient failure — surfaced as user: null below,
    // not thrown further up.
    throwOnError: false,
  });

  React.useEffect(() => {
    // §4.3's single 401-handling path: any request anywhere in the app that gets
    // UNAUTHENTICATED clears this cached user, so every consumer of useAuth() re-renders as
    // logged-out without each call site handling it individually.
    registerUnauthenticatedHandler(() => {
      queryClient.setQueryData(["auth", "me"], null);
    });
  }, [queryClient]);

  const value = React.useMemo<AuthContextValue>(
    () => ({ user: data ?? null, isLoading, refetch }),
    [data, isLoading, refetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth() must be used within <AuthProvider>");
  }
  return ctx;
}
