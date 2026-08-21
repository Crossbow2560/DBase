"use client";

// REQUIREMENTS.md §5.5 — there was previously no UI for this at all (no share buttons anywhere,
// despite the backend fully supporting grant/revoke/public links since Subcomponent 2). Two
// independent things live here: direct grants to specific registered users, and public share
// links; both share the same editor-or-above authorization on the backend.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Role = "viewer" | "editor";

interface Collaborator {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
}

interface ShareLink {
  id: string;
  token: string;
  role: Role;
  hasPassword: boolean;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
}

export function ShareModal({
  itemType,
  itemId,
  itemName,
  onClose,
}: {
  itemType: "file" | "folder";
  itemId: string;
  itemName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const collaboratorsKey = ["items", itemType, itemId, "permissions"] as const;
  const linksKey = ["items", itemType, itemId, "share-links"] as const;

  const { data: collaborators } = useQuery({
    queryKey: collaboratorsKey,
    queryFn: () => api.get<{ collaborators: Collaborator[] }>(`/items/${itemType}/${itemId}/permissions`),
  });
  const { data: links } = useQuery({
    queryKey: linksKey,
    queryFn: () => api.get<{ links: ShareLink[] }>(`/items/${itemType}/${itemId}/share-links`),
  });

  const [email, setEmail] = React.useState("");
  const [grantRole, setGrantRole] = React.useState<Role>("viewer");
  const [grantError, setGrantError] = React.useState<string | null>(null);
  const [linkRole, setLinkRole] = React.useState<Role>("viewer");
  const [linkPassword, setLinkPassword] = React.useState("");
  const [createdLinkToken, setCreatedLinkToken] = React.useState<string | null>(null);
  const [transferEmail, setTransferEmail] = React.useState("");
  const [transferError, setTransferError] = React.useState<string | null>(null);
  const [transferDone, setTransferDone] = React.useState(false);

  function invalidateCollaborators() {
    queryClient.invalidateQueries({ queryKey: collaboratorsKey });
  }
  function invalidateLinks() {
    queryClient.invalidateQueries({ queryKey: linksKey });
  }

  async function shareWithEmail(e: React.FormEvent) {
    e.preventDefault();
    setGrantError(null);
    try {
      const { user: target } = await api.get<{ user: { id: string } }>(
        `/users/lookup?email=${encodeURIComponent(email)}`,
      );
      await api.post(`/items/${itemType}/${itemId}/permissions`, { userId: target.id, role: grantRole });
      setEmail("");
      invalidateCollaborators();
    } catch (err) {
      setGrantError(err instanceof ApiError ? err.message : "Could not share with that email.");
    }
  }

  async function removeCollaborator(collaborator: Collaborator) {
    await api.delete(`/items/${itemType}/${itemId}/permissions/${collaborator.userId}`);
    invalidateCollaborators();
  }

  async function createLink(e: React.FormEvent) {
    e.preventDefault();
    const { token } = await api.post<{ token: string }>(`/items/${itemType}/${itemId}/share-links`, {
      role: linkRole,
      password: linkPassword || undefined,
    });
    setCreatedLinkToken(token);
    setLinkPassword("");
    invalidateLinks();
  }

  async function revokeLink(link: ShareLink) {
    await api.delete(`/share-links/${link.id}`);
    invalidateLinks();
  }

  function linkUrl(token: string) {
    return `${window.location.origin}/s/${token}`;
  }

  async function transferOwnership(e: React.FormEvent) {
    e.preventDefault();
    setTransferError(null);
    setTransferDone(false);
    try {
      const { user: target } = await api.get<{ user: { id: string } }>(
        `/users/lookup?email=${encodeURIComponent(transferEmail)}`,
      );
      await api.post(`/items/${itemType}/${itemId}/transfer-ownership`, { newOwnerId: target.id });
      setTransferEmail("");
      setTransferDone(true);
      invalidateCollaborators();
    } catch (err) {
      setTransferError(err instanceof ApiError ? err.message : "Could not transfer ownership.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="max-h-full w-full max-w-lg overflow-auto rounded-md bg-background p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Share &quot;{itemName}&quot;</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">People with access</h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {collaborators?.collaborators.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">Only you have access.</li>
            )}
            {collaborators?.collaborators.map((c) => (
              <li key={c.userId} className="flex items-center justify-between px-3 py-2 text-sm">
                <span>
                  {c.displayName} <span className="text-muted-foreground">({c.email})</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground">{c.role}</span>
                  <Button variant="ghost" size="sm" onClick={() => removeCollaborator(c)}>
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>

          <form onSubmit={shareWithEmail} className="flex gap-2">
            <Input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="flex-1"
            />
            <select
              value={grantRole}
              onChange={(e) => setGrantRole(e.target.value as Role)}
              className="rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <Button type="submit">Share</Button>
          </form>
          {grantError && <p className="text-sm text-destructive">{grantError}</p>}
        </section>

        <section className="mt-6 space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Public links</h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {links?.links.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">No public links yet.</li>
            )}
            {links?.links.map((link) => (
              <li key={link.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="truncate">
                  {linkUrl(link.token)}{" "}
                  <span className="text-muted-foreground">
                    ({link.role}
                    {link.hasPassword ? ", password-protected" : ""})
                  </span>
                </span>
                {link.createdBy === user?.id && (
                  <Button variant="ghost" size="sm" onClick={() => revokeLink(link)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>

          <form onSubmit={createLink} className="flex gap-2">
            <select
              value={linkRole}
              onChange={(e) => setLinkRole(e.target.value as Role)}
              className="rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <Input
              type="password"
              placeholder="Optional password"
              value={linkPassword}
              onChange={(e) => setLinkPassword(e.target.value)}
              className="flex-1"
            />
            <Button type="submit">Create link</Button>
          </form>
          {createdLinkToken && (
            <p className="break-all rounded-md bg-muted/50 p-2 text-sm">
              Link created: {linkUrl(createdLinkToken)}
            </p>
          )}
        </section>

        <section className="mt-6 space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Transfer ownership</h3>
          <p className="text-xs text-muted-foreground">
            Only the current owner (or an admin) can do this — the new owner gets full control, and you're kept on
            as an editor.
          </p>
          <form onSubmit={transferOwnership} className="flex gap-2">
            <Input
              type="email"
              placeholder="New owner's email"
              value={transferEmail}
              onChange={(e) => setTransferEmail(e.target.value)}
              required
              className="flex-1"
            />
            <Button type="submit" variant="outline">
              Transfer
            </Button>
          </form>
          {transferError && <p className="text-sm text-destructive">{transferError}</p>}
          {transferDone && <p className="text-sm text-muted-foreground">Ownership transferred.</p>}
        </section>
      </div>
    </div>
  );
}
