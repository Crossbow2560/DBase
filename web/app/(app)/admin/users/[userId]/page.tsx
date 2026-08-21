"use client";

// Browse-only — see the action-placement note on /admin/users. Every load of this page is
// itself a `view` action the backend must log (REQUIREMENTS.md §5.10, once per browsing
// session, not per file — APPLICATION_DESIGN.md §4.6), which is the backend's responsibility on
// the GET /admin/users/:id/files call, not something this page does itself.

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

interface AdminFileItem {
  id: string;
  name: string;
  type: "file" | "folder";
}

// Next.js 15: `params` is a Promise. This is a Client Component (uses useQuery), so it can't be
// an async function — React's use() unwraps the Promise synchronously instead.
export default function AdminUserFilesPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminUserFiles(userId),
    queryFn: () => api.get<{ items: AdminFileItem[] }>(`/admin/users/${userId}/files`),
  });

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">User&apos;s files</h1>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <ul className="divide-y divide-border rounded-md border border-border">
        {data?.items.map((item) => (
          <li key={item.id} className="px-3 py-2 text-sm">
            {item.type === "folder" ? "📁" : "📄"} {item.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
