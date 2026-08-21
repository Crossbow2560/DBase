"use client";

import * as React from "react";
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
      <div className="w-full max-w-sm space-y-2 rounded-lg border border-border p-6 text-sm">
        <p>If that email is registered, a reset link has been sent.</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-border p-6">
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
