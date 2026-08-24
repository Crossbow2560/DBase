"use client";

import * as React from "react";
import Link from "next/link";
import { User, Mail, ArrowRight, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { api, ApiError } from "@/lib/api-client";

export default function RegisterPage() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [registeredEmail, setRegisteredEmail] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await api.post("/auth/register", { email, password, displayName });
      // Not a redirect to /login: the account can't log in yet until the verification link is
      // followed (accounts/service.ts's login() blocks on email_verified) — sending someone
      // straight to a login form they can't successfully use yet would just be confusing.
      setRegisteredEmail(email);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (registeredEmail) {
    return (
      <div className="mx-auto w-full max-w-sm">
        <div className="space-y-3 rounded-2xl border border-border bg-background/70 p-6 text-center shadow-xl shadow-[#1A3D63]/5 backdrop-blur-xl">
          <MailCheck className="mx-auto h-8 w-8 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold">Check your email</h1>
          <p className="text-sm text-muted-foreground">
            We sent a verification link to <span className="font-medium text-foreground">{registeredEmail}</span>.
            Follow it to activate your account before logging in.
          </p>
          <Link href="/login" className="inline-block text-sm font-medium text-accent hover:underline">
            Back to log in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <p className="mb-6 text-center text-sm text-muted-foreground">Create an account to get started</p>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-2xl border border-border bg-background/70 p-6 shadow-xl shadow-[#1A3D63]/5 backdrop-blur-xl"
      >
        <h1 className="text-xl font-semibold">Create an account</h1>

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="space-y-1.5">
          <label htmlFor="displayName" className="text-sm font-medium">
            Name
          </label>
          <div className="relative">
            <User
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="displayName"
              autoComplete="name"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <div className="relative">
            <Mail
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? (
            "Creating account…"
          ) : (
            <>
              Create account
              <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
            </>
          )}
        </Button>
      </form>

      <p className="mt-4 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
