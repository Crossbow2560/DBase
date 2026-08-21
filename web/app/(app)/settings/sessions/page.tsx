"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";

interface Session {
  id: string;
  device_info: string | null;
  created_at: string;
  expires_at: string;
}

export default function SessionsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.sessions(),
    queryFn: () => api.get<{ sessions: Session[] }>("/auth/sessions").then((r) => r.sessions),
  });

  async function revoke(sessionId: string) {
    await api.delete(`/auth/sessions/${sessionId}`);
    queryClient.invalidateQueries({ queryKey: queryKeys.sessions() });
  }

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Devices</h1>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.length === 0 && <p className="text-sm text-muted-foreground">No active sessions.</p>}
      <ul className="space-y-2">
        {data?.map((session) => (
          <li key={session.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
            <div>
              <div>{session.device_info ?? "Unknown device"}</div>
              <div className="text-muted-foreground">
                Expires {new Date(session.expires_at).toLocaleDateString()}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => revoke(session.id)}>
              Log out
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
