"use client";

// Browse-only — see the action-placement note on /admin/users. Every load of this page is
// itself a `view` action the backend must log (REQUIREMENTS.md §5.10, once per browsing
// session, not per file — APPLICATION_DESIGN.md §4.6), which is the backend's responsibility on
// the GET /admin/users/:id/files call, not something this page does itself.

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { Folder, FileText } from "lucide-react";
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
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">User&apos;s files</h1>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">This user has no files.</p>}
      {data && data.items.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Name</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.items.map((item) => (
                <tr key={item.id} className="hover:bg-muted/30">
                  <td className="px-4 py-2.5 align-middle">
                    <div className="flex items-center gap-2.5">
                      {item.type === "folder" ? (
                        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      <span className="font-medium">{item.name}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
