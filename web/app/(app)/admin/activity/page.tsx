"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

interface ActivityLogEntry {
  id: string;
  action: string;
  actorId: string | null;
  subjectUserId: string | null;
  createdAt: string;
}

export default function AdminActivityPage() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminActivity(),
    queryFn: () => api.get<{ entries: ActivityLogEntry[] }>("/admin/activity"),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Activity log</h1>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-2">Action</th>
            <th className="py-2">Actor</th>
            <th className="py-2">Subject</th>
            <th className="py-2">When</th>
          </tr>
        </thead>
        <tbody>
          {data?.entries.map((entry) => (
            <tr key={entry.id} className="border-b border-border">
              <td className="py-2">{entry.action}</td>
              <td className="py-2 text-muted-foreground">{entry.actorId ?? "—"}</td>
              <td className="py-2 text-muted-foreground">{entry.subjectUserId ?? "—"}</td>
              <td className="py-2 text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
