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

  // SECURITY: the QueryClient in app/providers.tsx is a single long-lived instance for the whole
  // browser tab — nothing about it is per-user. Every other query in this app (folder contents,
  // favorites, search, shared-with-me, admin views, ...) is keyed by resource id, never by user
  // id, so without this, logging out and logging back in as someone else on the same tab kept
  // serving the previous account's cached responses — instantly on remount, and even after a
  // background refetch, that refetch's own inflight promise could still resolve into a component
  // that had already unmounted/remounted for the new user (found by actually switching accounts
  // in the browser and watching the old account's file list render first). Whenever the resolved
  // user id changes — login, logout, or switching accounts — wipe every cached query except this
  // one (["auth","me"] itself, which already just got its correct fresh value from this same
  // resolution) so every other view is forced to refetch scoped to whoever is actually logged in
  // now. The isLoading guard skips the very first resolution after mount, when there's nothing
  // stale to clear yet.
  const lastUserIdRef = React.useRef<string | null>(null);
  const hasResolvedOnceRef = React.useRef(false);
  React.useEffect(() => {
    if (isLoading) return;
    const currentUserId = data?.id ?? null;
    if (hasResolvedOnceRef.current && currentUserId !== lastUserIdRef.current) {
      // resetQueries, not removeQueries: removeQueries only deletes the cache entry — an
      // already-mounted component's useQuery() keeps returning its last-fetched `data` from
      // before the identity change until something re-renders it, so the previous account's
      // data stayed on screen with removeQueries alone (confirmed by hand: switching accounts
      // without a full page reload left the old account's file list visible). resetQueries
      // clears each matching query back to pending state (so the stale data actually disappears
      // from what useQuery returns) and immediately refetches every one that's still mounted.
      queryClient.resetQueries({
        predicate: (query) => !(query.queryKey[0] === "auth" && query.queryKey[1] === "me"),
      });
    }
    lastUserIdRef.current = currentUserId;
    hasResolvedOnceRef.current = true;
  }, [data, isLoading, queryClient]);

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
