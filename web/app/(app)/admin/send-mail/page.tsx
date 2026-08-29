"use client";

// Admin-only one-off email composer. Sends through the same provider (Resend, src/lib/email.ts)
// and DBase-skinned shell (src/lib/emailTemplate.ts) as the verification / password-reset mails,
// so anything sent here arrives from the configured domain with the standard template around it.

import * as React from "react";
import { Loader2, Mail } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

export default function AdminSendMailPage() {
  const [to, setTo] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sentTo, setSentTo] = React.useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    setSentTo(null);
    try {
      await api.post("/admin/send-email", { to, subject, body });
      setSentTo(to);
      setTo("");
      setSubject("");
      setBody("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to send email.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={send} className="max-w-lg space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Send mail</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sends a one-off email from the DBase domain, wrapped in the same template used for
          account verification emails. The body is sent as plain text.
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor="to" className="text-sm font-medium">
          To
        </label>
        <input
          id="to"
          type="email"
          required
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="person@example.com"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="subject" className="text-sm font-medium">
          Subject
        </label>
        <input
          id="subject"
          type="text"
          required
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="body" className="text-sm font-medium">
          Message
        </label>
        <textarea
          id="body"
          required
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {sentTo && (
        <p className="text-sm text-muted-foreground">
          Sent to <span className="font-medium">{sentTo}</span>.
        </p>
      )}

      <Button type="submit" disabled={sending}>
        {sending ? (
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Mail className="mr-1.5 h-4 w-4" aria-hidden />
        )}
        {sending ? "Sending…" : "Send email"}
      </Button>
    </form>
  );
}
