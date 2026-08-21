"use client";

// DESIGN.md §3.10: a stuck DELETION_QUEUE row after bounded automatic retries — surfaced here
// for manual investigation, not something the UI can resolve on its own.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

interface FailedJob {
  id: string;
  itemType: "file" | "folder";
  itemId: string;
  attempts: number;
  enqueuedAt: string;
}

export default function AdminFailedJobsPage() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminFailedJobs(),
    queryFn: () => api.get<{ jobs: FailedJob[] }>("/admin/failed-jobs"),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Failed deletion jobs</h1>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.jobs.length === 0 && <p className="text-sm text-muted-foreground">No stuck jobs.</p>}
      <ul className="divide-y divide-border rounded-md border border-border">
        {data?.jobs.map((job) => (
          <li key={job.id} className="break-words px-3 py-2 text-sm">
            {job.itemType} {job.itemId} — {job.attempts} attempts, enqueued{" "}
            {new Date(job.enqueuedAt).toLocaleString()}
          </li>
        ))}
      </ul>
    </div>
  );
}
