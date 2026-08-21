"use client";

// FRONTEND_DESIGN.md §4.2: quota/role/deactivate/reactivate/delete are row-level actions here;
// /admin/users/[userId] is browse-only and does not duplicate them.

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  }

  async function toggleActive(userRow: AdminUserRow) {
    await api.post(`/admin/users/${userRow.id}/${userRow.isActive ? "deactivate" : "reactivate"}`);
    invalidate();
  }

  async function deleteUser(userRow: AdminUserRow) {
    if (!confirm(`Permanently delete ${userRow.email}? This cannot be undone.`)) return;
    await api.delete(`/admin/users/${userRow.id}`);
    invalidate();
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
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-2">User</th>
            <th className="py-2">Role</th>
            <th className="py-2">Status</th>
            <th className="py-2">Storage</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {data?.users.map((userRow) => (
            <tr key={userRow.id} className="border-b border-border">
              <td className="py-2">
                <Link href={`/admin/users/${userRow.id}`} className="hover:underline">
                  {userRow.displayName}
                </Link>
                <div className="text-muted-foreground">{userRow.email}</div>
              </td>
              <td className="py-2">
                <div className="flex items-center gap-2">
                  <span>{userRow.role}</span>
                  <Button variant="outline" size="sm" onClick={() => toggleRole(userRow)}>
                    {userRow.role === "admin" ? "Demote" : "Promote"}
                  </Button>
                </div>
              </td>
              <td className="py-2">{userRow.isActive ? "Active" : "Deactivated"}</td>
              <td className="py-2">
                {editingQuotaId === userRow.id ? (
                  <div className="flex items-center gap-1">
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
              <td className="py-2 space-x-2 text-right">
                <Button variant="outline" size="sm" onClick={() => toggleActive(userRow)}>
                  {userRow.isActive ? "Deactivate" : "Reactivate"}
                </Button>
                <Button variant="destructive" size="sm" onClick={() => deleteUser(userRow)}>
                  Delete
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
