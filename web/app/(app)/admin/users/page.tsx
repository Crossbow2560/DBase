"use client";

// FRONTEND_DESIGN.md §4.2: quota/role/deactivate/reactivate/delete are row-level actions here;
// /admin/users/[userId] is browse-only and does not duplicate them.

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
  isActive: boolean;
  storageUsedBytes: number;
  storageQuotaBytes: number;
}

export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminUsers(),
    queryFn: () => api.get<{ users: AdminUserRow[] }>("/admin/users"),
  });

  const [editingQuotaId, setEditingQuotaId] = React.useState<string | null>(null);
  const [quotaGb, setQuotaGb] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers() });
    // Quota changes and deletions move the system-wide allocated total (0022 pre-allocation).
    queryClient.invalidateQueries({ queryKey: queryKeys.adminSystemStorage() });
  }

  async function toggleActive(userRow: AdminUserRow) {
    await api.post(`/admin/users/${userRow.id}/${userRow.isActive ? "deactivate" : "reactivate"}`);
    invalidate();
  }

  const [deletingUser, setDeletingUser] = React.useState<AdminUserRow | null>(null);
  const [isDeletingUser, setIsDeletingUser] = React.useState(false);
  const [deleteUserError, setDeleteUserError] = React.useState<string | null>(null);

  async function confirmDeleteUser() {
    if (!deletingUser) return;
    setIsDeletingUser(true);
    setDeleteUserError(null);
    try {
      await api.delete(`/admin/users/${deletingUser.id}`);
      setDeletingUser(null);
      invalidate();
    } catch (err) {
      setDeleteUserError(err instanceof ApiError ? err.message : "Could not delete this user.");
    } finally {
      setIsDeletingUser(false);
    }
  }

  async function toggleRole(userRow: AdminUserRow) {
    setError(null);
    try {
      await api.patch(`/admin/users/${userRow.id}/role`, { role: userRow.role === "admin" ? "user" : "admin" });
      invalidate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change role.");
    }
  }

  function startEditingQuota(userRow: AdminUserRow) {
    setEditingQuotaId(userRow.id);
    setQuotaGb((userRow.storageQuotaBytes / 1e9).toString());
    setError(null);
  }

  async function saveQuota(userRow: AdminUserRow) {
    const gb = Number(quotaGb);
    if (!Number.isFinite(gb) || gb < 0) {
      setError("Quota must be a non-negative number of GB.");
      return;
    }
    setError(null);
    try {
      await api.patch(`/admin/users/${userRow.id}/quota`, { quotaBytes: Math.round(gb * 1e9) });
      setEditingQuotaId(null);
      invalidate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change quota.");
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Users</h1>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th className="whitespace-nowrap px-3 py-2">User</th>
              <th className="hidden whitespace-nowrap px-3 py-2 sm:table-cell">Role</th>
              <th className="hidden whitespace-nowrap px-3 py-2 md:table-cell">Status</th>
              <th className="whitespace-nowrap px-3 py-2">Storage</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {data?.users.map((userRow) => (
              <tr key={userRow.id} className="border-b border-border">
                <td className="whitespace-nowrap px-3 py-2">
                  <Link href={`/admin/users/${userRow.id}`} className="hover:underline">
                    {userRow.displayName}
                  </Link>
                  <div className="text-muted-foreground">{userRow.email}</div>
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2 sm:table-cell">
                  <div className="flex items-center gap-2">
                    <span>{userRow.role}</span>
                    <Button variant="outline" size="sm" onClick={() => toggleRole(userRow)}>
                      {userRow.role === "admin" ? "Demote" : "Promote"}
                    </Button>
                  </div>
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2 md:table-cell">
                  {userRow.isActive ? "Active" : "Deactivated"}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {editingQuotaId === userRow.id ? (
                    <div className="flex flex-wrap items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        step="0.1"
                        value={quotaGb}
                        onChange={(e) => setQuotaGb(e.target.value)}
                        className="w-20"
                      />
                      <span className="text-muted-foreground">GB</span>
                      <Button size="sm" onClick={() => saveQuota(userRow)}>
                        Save
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditingQuotaId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => startEditingQuota(userRow)}
                      title="Click to edit quota"
                    >
                      {(userRow.storageUsedBytes / 1e9).toFixed(2)} / {(userRow.storageQuotaBytes / 1e9).toFixed(2)} GB
                    </button>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => toggleActive(userRow)}>
                      {userRow.isActive ? "Deactivate" : "Reactivate"}
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => setDeletingUser(userRow)}>
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deletingUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => !isDeletingUser && setDeletingUser(null)}
        >
          <div className="w-full max-w-sm space-y-3 rounded-md bg-background p-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold">Delete user</h2>
            <p className="text-sm text-muted-foreground">
              Permanently delete {deletingUser.email}? This cannot be undone.
            </p>
            {deleteUserError && <p className="text-sm text-destructive">{deleteUserError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setDeletingUser(null)} disabled={isDeletingUser}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={confirmDeleteUser} disabled={isDeletingUser}>
                {isDeletingUser ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
