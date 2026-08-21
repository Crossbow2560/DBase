"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const { refetch } = useAuth();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await api.post("/auth/login", { email, password });
      // Deliberately no router.replace() here — (auth)/layout.tsx's own effect redirects away
      // once `user` becomes truthy after this refetch resolves. Calling both was a real race:
      // the layout's effect and this handler both fired router.replace("/folders") for the same
      // transition, which aborted one of the two navigations and left the router stuck on
      // /login despite a valid session (confirmed by hand — direct fetch("/auth/me") succeeded
      // while the UI was still showing the login form). One source of truth for this redirect.
      await refetch();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-border p-6">
      <h1 className="text-xl font-semibold">Log in</h1>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <Input
          id="password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? "Logging in…" : "Log in"}
      </Button>
      <div className="flex justify-between text-sm text-muted-foreground">
        <Link href="/register">Create an account</Link>
        <Link href="/password-reset/request">Forgot password?</Link>
      </div>
    </form>
  );
}
