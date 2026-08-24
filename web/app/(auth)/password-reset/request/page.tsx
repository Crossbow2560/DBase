"use client";

import * as React from "react";
import Link from "next/link";
import { Mail, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";

export default function PasswordResetRequestPage() {
  const [email, setEmail] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    // Always succeeds from the client's point of view — the backend returns 200 regardless of
    // whether the email exists (REQUIREMENTS.md §5.1 non-enumeration), so there's nothing to
    // branch on here.
    await api.post("/auth/password-reset/request", { email }).finally(() => setIsSubmitting(false));
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="mx-auto w-full max-w-sm">
        <div className="space-y-2 rounded-2xl border border-border bg-background/70 p-6 text-sm shadow-xl shadow-[#1A3D63]/5 backdrop-blur-xl">
          <p>If that email is registered, a reset link has been sent.</p>
        </div>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          <Link href="/login" className="font-medium text-accent hover:underline">
            Back to log in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <p className="mb-6 text-center text-sm text-muted-foreground">
        We&apos;ll email you a link to get back in
      </p>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-2xl border border-border bg-background/70 p-6 shadow-xl shadow-[#1A3D63]/5 backdrop-blur-xl"
      >
        <h1 className="text-xl font-semibold">Reset your password</h1>
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
        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? (
            "Sending…"
          ) : (
            <>
              Send reset link
              <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
            </>
          )}
        </Button>
      </form>

      <p className="mt-4 text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-medium text-accent hover:underline">
          Back to log in
        </Link>
      </p>
    </div>
  );
}
