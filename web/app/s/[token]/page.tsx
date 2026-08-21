"use client";

// REQUIREMENTS.md §5.5: access without requiring an account — the one route outside the
// authenticated (app) shell entirely (FRONTEND_DESIGN.md §4.2). Not wrapped in AuthProvider's
// redirect gates since it has none; it does still sit under the root layout's Providers (query
// client), just not (app)'s or (auth)'s route-group layouts.

import * as React from "react";
import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { Folder, FileText } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SharedFolderContents {
  name: string;
  role: "viewer" | "editor";
  items: { id: string; name: string; type: "file" | "folder" }[];
}

// Next.js 15: `params` is a Promise; use() unwraps it in this Client Component (see the same
// pattern's comment in admin/users/[userId]/page.tsx).
export default function PublicShareLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [password, setPassword] = React.useState("");
  const [submittedPassword, setSubmittedPassword] = React.useState<string | undefined>(undefined);

  const { data, error, isLoading } = useQuery({
    queryKey: ["public-share-link", token, submittedPassword],
    queryFn: () =>
      api.get<SharedFolderContents>(
        `/public/share-links/${token}${submittedPassword ? `?password=${encodeURIComponent(submittedPassword)}` : ""}`,
      ),
  });

  const needsPassword = error instanceof ApiError && error.status === 401;

  if (needsPassword) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmittedPassword(password);
          }}
          className="w-full max-w-sm space-y-4 rounded-lg border border-border p-6"
        >
          <h1 className="text-lg font-semibold">This link is password-protected</h1>
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" className="w-full">
            Unlock
          </Button>
        </form>
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-destructive">
        This link is invalid, expired, or no longer available.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">{data?.name}</h1>
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">This folder is empty.</p>}
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
