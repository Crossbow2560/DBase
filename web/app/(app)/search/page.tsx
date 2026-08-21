"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
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
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Search</h1>
      <Input placeholder="Search files and folders…" value={term} onChange={(e) => setTerm(e.target.value)} />
      {isFetching && <p className="text-sm text-muted-foreground">Searching…</p>}
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
