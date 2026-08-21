"use client";

// REQUIREMENTS.md §5.1.1: irreversible, so this page requires its own explicit confirmation
// step rather than a context-menu action (FRONTEND_DESIGN.md §4.2). Calls DELETE
// /api/v1/users/me — documented in APPLICATION_DESIGN.md §4.6 but not yet implemented by the
// backend (Subcomponent 7, Account Lifecycle), so this will 404 until that lands.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api-client";

export default function AccountSettingsPage() {
  const [confirmation, setConfirmation] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const router = useRouter();

  async function onDelete() {
    setError(null);
    setIsDeleting(true);
    try {
      await api.delete("/users/me");
      router.replace("/login");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-xl font-semibold">Account</h1>
      <div className="space-y-2 rounded-md border border-destructive/40 p-4">
        <h2 className="font-medium text-destructive">Delete account</h2>
        <p className="text-sm text-muted-foreground">
          This cannot be undone. Your owned files and folders will be reassigned to the system
          admin account (REQUIREMENTS.md §5.1.1).
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <label htmlFor="confirm" className="block text-sm font-medium">
          Type DELETE to confirm
        </label>
        <Input id="confirm" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
        <Button
          variant="destructive"
          disabled={confirmation !== "DELETE" || isDeleting}
          onClick={onDelete}
        >
          {isDeleting ? "Deleting…" : "Delete my account"}
        </Button>
      </div>
    </div>
  );
}
