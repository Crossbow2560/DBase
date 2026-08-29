"use client";

// Admin view of inbound mail delivered to the deployment address (EMAIL_INBOUND_ADDRESS,
// default dbase@nishit-db.com). Messages arrive via the Resend inbound webhook
// (src/modules/email/routes.ts -> POST /api/v1/email/inbound) and are stored in received_emails.
// Read-only — this tab just lists and displays them.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

interface Attachment {
  id: string | null;
  filename: string;
  contentType: string | null;
}

interface ReceivedEmail {
  id: string;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  attachments: Attachment[];
  receivedAt: string;
}

export default function AdminReceivedMailPage() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminReceivedEmails(),
    queryFn: () =>
      api.get<{ emails: ReceivedEmail[]; inboundAddress: string }>("/admin/received-emails"),
    refetchInterval: 30_000,
  });

  const emails = data?.emails ?? [];
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = emails.find((e) => e.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Received mail</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Inbound messages sent to{" "}
          <code className="rounded bg-muted px-1 py-0.5">{data?.inboundAddress ?? "the DBase address"}</code>.
          Refreshes automatically.
        </p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && emails.length === 0 && (
        <p className="text-sm text-muted-foreground">No mail received yet.</p>
      )}

      {emails.length > 0 && (
        <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_1fr]">
          <ul className="divide-y divide-border rounded-lg border border-border">
            {emails.map((email) => (
              <li key={email.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(email.id)}
                  className={
                    "block w-full px-3 py-2 text-left text-sm hover:bg-muted " +
                    (email.id === selectedId ? "bg-muted" : "")
                  }
                >
                  <div className="truncate font-medium">{email.subject || "(no subject)"}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(email.receivedAt).toLocaleString()}
                  </div>
                </button>
              </li>
            ))}
          </ul>

          <div className="min-w-0 rounded-lg border border-border p-4">
            {!selected && (
              <p className="text-sm text-muted-foreground">Select a message to read it.</p>
            )}
            {selected && (
              <div className="space-y-3">
                <div className="space-y-1 border-b border-border pb-3">
                  <div className="text-base font-semibold">{selected.subject || "(no subject)"}</div>
                  <div className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">From:</span>{" "}
                    {selected.fromName
                      ? `${selected.fromName} <${selected.fromAddress}>`
                      : selected.fromAddress}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">To:</span> {selected.toAddress}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {new Date(selected.receivedAt).toLocaleString()}
                  </div>
                </div>

                {selected.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {selected.attachments.map((att, i) => (
                      <span
                        key={att.id ?? i}
                        className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/40 px-2 py-1 text-xs"
                        title={att.contentType ?? undefined}
                      >
                        <Paperclip className="h-3 w-3" aria-hidden />
                        {att.filename}
                      </span>
                    ))}
                  </div>
                )}

                {selected.textBody ? (
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                    {selected.textBody}
                  </pre>
                ) : selected.htmlBody ? (
                  // Sandboxed: no scripts, no same-origin — the HTML can't touch this app.
                  <iframe
                    title="Message body"
                    sandbox=""
                    className="h-[60vh] w-full rounded border border-border bg-white"
                    srcDoc={selected.htmlBody}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">(empty message)</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
