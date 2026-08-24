"use client";

import * as React from "react";
import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { api, ApiError } from "@/lib/api-client";

function ConfirmForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [newPassword, setNewPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await api.post("/auth/password-reset/confirm", { token, newPassword });
      router.replace("/login");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="mx-auto w-full max-w-sm">
        <div className="space-y-2 rounded-2xl border border-border bg-background/70 p-6 text-sm text-destructive shadow-xl shadow-[#1A3D63]/5 backdrop-blur-xl">
          This reset link is missing its token.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <p className="mb-6 text-center text-sm text-muted-foreground">Choose a new password below</p>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-2xl border border-border bg-background/70 p-6 shadow-xl shadow-[#1A3D63]/5 backdrop-blur-xl"
      >
        <h1 className="text-xl font-semibold">Choose a new password</h1>
        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="space-y-1.5">
          <label htmlFor="newPassword" className="text-sm font-medium">
            New password
          </label>
          <PasswordInput
            id="newPassword"
            autoComplete="new-password"
            required
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? (
            "Updating…"
          ) : (
            <>
              Update password
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

export default function PasswordResetConfirmPage() {
  return (
    <Suspense>
      <ConfirmForm />
    </Suspense>
  );
}
