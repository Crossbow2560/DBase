"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Folder, FileText, SearchIcon } from "lucide-react";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { Input } from "@/components/ui/input";

interface SearchResultItem {
  id: string;
  name: string;
  type: "file" | "folder";
}

export default function SearchPage() {
  const [term, setTerm] = React.useState("");

  const { data, isFetching } = useQuery({
    queryKey: queryKeys.search(term),
    queryFn: () => api.get<{ items: SearchResultItem[] }>(`/search?q=${encodeURIComponent(term)}`),
    enabled: term.trim().length > 0,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Search</h1>
      <div className="relative max-w-md">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          placeholder="Search files and folders…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          className="pl-9"
        />
      </div>

      {isFetching && <p className="text-sm text-muted-foreground">Searching…</p>}
      {!isFetching && term.trim().length > 0 && data && data.items.length === 0 && (
        <p className="text-sm text-muted-foreground">No results for &quot;{term}&quot;.</p>
      )}

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
