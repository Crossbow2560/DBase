"use client";

// REQUIREMENTS.md §5.1: self-service profile/password management, plus §5.1.1's irreversible
// account deletion below — that one keeps its own explicit confirmation step rather than a
// context-menu action (FRONTEND_DESIGN.md §4.2).

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";

function ProfileSection() {
  const { user, refetch } = useAuth();
  const [displayName, setDisplayName] = React.useState(user?.displayName ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  // Only correct once /auth/me has actually resolved — the form starts blank on first render
  // (user is null until then) and needs to pick up the real name once it lands.
  React.useEffect(() => {
    if (user) setDisplayName(user.displayName);
  }, [user]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setIsSaving(true);
    try {
      await api.patch("/users/me", { displayName });
      refetch();
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-border p-4">
      <h2 className="font-medium">Profile</h2>
      <div className="space-y-1">
        <label htmlFor="email" className="block text-sm font-medium text-muted-foreground">
          Email
        </label>
        <Input id="email" value={user?.email ?? ""} disabled />
      </div>
      <div className="space-y-1">
        <label htmlFor="displayName" className="block text-sm font-medium">
          Name
        </label>
        <Input
          id="displayName"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setSaved(false);
          }}
          maxLength={255}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && !error && <p className="text-sm text-accent">Saved.</p>}
      <Button type="submit" disabled={!displayName.trim() || displayName === user?.displayName || isSaving}>
        {isSaving ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}

function PasswordSection() {
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match.");
      return;
    }
    setIsSaving(true);
    try {
      await api.post("/auth/change-password", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-border p-4">
      <h2 className="font-medium">Password</h2>
      <p className="text-sm text-muted-foreground">
        Changing your password signs you out on every other device — this one stays signed in.
      </p>
      <div className="space-y-1">
        <label htmlFor="currentPassword" className="block text-sm font-medium">
          Current password
        </label>
        <Input
          id="currentPassword"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="newPassword" className="block text-sm font-medium">
          New password
        </label>
        <Input
          id="newPassword"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="confirmPassword" className="block text-sm font-medium">
          Confirm new password
        </label>
        <Input
          id="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
        />
        {mismatch && <p className="text-sm text-destructive">Passwords don&apos;t match.</p>}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && !error && <p className="text-sm text-accent">Password updated.</p>}
      <Button type="submit" disabled={!currentPassword || !newPassword || mismatch || isSaving}>
        {isSaving ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}

function DeleteAccountSection() {
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
    <div className="space-y-2 rounded-md border border-destructive/40 p-4">
      <h2 className="font-medium text-destructive">Delete account</h2>
      <p className="text-sm text-muted-foreground">
        This cannot be undone. Your owned files and folders will be reassigned to the system
        admin account.
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
  );
}

export default function AccountSettingsPage() {
  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-xl font-semibold">Account</h1>
      <ProfileSection />
      <PasswordSection />
      <DeleteAccountSection />
    </div>
  );
}
