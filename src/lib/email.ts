import { config } from "../config.js";

// Plain fetch against Resend's REST API rather than their SDK — one endpoint, one shape, not
// worth a dependency for it. Falls back to logging when RESEND_API_KEY isn't configured (dev
// default, config.ts's comment) so registration/password-reset still work end-to-end locally
// without real email infra — the same shape the password-reset flow already had before this
// module existed (it used to console.log the raw link directly; this generalizes that fallback
// to any email, verification included).
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!config.email.resendApiKey) {
    console.log(`[email] (RESEND_API_KEY not set, not actually sent) to=${to} subject="${subject}"\n${html}`);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.email.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: config.email.from, to, subject, html }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // Deliberately throws rather than swallowing: a misconfigured/failing email provider means
    // the registrant never gets their verification link at all — surfacing that as a real error
    // (visible in logs, and to the caller) is the whole point of not silently no-op'ing here the
    // way the RESEND_API_KEY-unset dev fallback above does on purpose.
    throw new Error(`Resend API error (${response.status}): ${body}`);
  }
}
