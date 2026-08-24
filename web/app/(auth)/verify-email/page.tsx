"use client";

import * as React from "react";
import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";

type Status = "verifying" | "success" | "error";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [status, setStatus] = React.useState<Status>("verifying");
  const [error, setError] = React.useState<string | null>(null);

  // Fires once per token (React 18 Strict Mode double-invokes effects in dev, but
  // verifyEmail() is idempotent-safe to call twice — a used token just 400s harmlessly the
  // second time, no different from a user double-clicking the link in two tabs).
  React.useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("This verification link is missing its token.");
      return;
    }
    api
      .post("/auth/verify-email", { token })
      .then(() => setStatus("success"))
      .catch((err) => {
        setStatus("error");
        setError(err instanceof ApiError ? err.message : "Something went wrong.");
      });
  }, [token]);

  return (
    <div className="mx-auto w-full max-w-sm">
      <div className="space-y-3 rounded-2xl border border-border bg-background/70 p-6 text-center shadow-xl shadow-[#1A3D63]/5 backdrop-blur-xl">
        {status === "verifying" && (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-accent" aria-hidden />
            <h1 className="text-lg font-semibold">Verifying your email…</h1>
          </>
        )}
        {status === "success" && (
          <>
            <CheckCircle2 className="mx-auto h-8 w-8 text-accent" aria-hidden />
            <h1 className="text-lg font-semibold">Email verified</h1>
            <p className="text-sm text-muted-foreground">You can now log in to your account.</p>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle className="mx-auto h-8 w-8 text-destructive" aria-hidden />
            <h1 className="text-lg font-semibold">Verification failed</h1>
            <p className="text-sm text-muted-foreground">{error}</p>
          </>
        )}
        <Link href="/login" className="inline-block text-sm font-medium text-accent hover:underline">
          Back to log in
        </Link>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
