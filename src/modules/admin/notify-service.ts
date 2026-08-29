import { sendEmail } from "../../lib/email.js";
import { renderEmailLayout } from "../../lib/emailTemplate.js";
import { AppError } from "../accounts/errors.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Admin-composed one-off email, wrapped in the same DBase-skinned shell (lib/emailTemplate.ts)
 * as the verification and password-reset mails. The body is plain text typed by the admin —
 * escaped and newline-to-<br>'d here, never rendered as raw HTML.
 */
export async function sendAdminEmail(input: {
  to: string;
  subject: string;
  body: string;
}): Promise<void> {
  const to = input.to.trim();
  const subject = input.subject.trim();
  const body = input.body.trim();

  if (!EMAIL_RE.test(to)) throw new AppError(400, "INVALID_EMAIL", "Enter a valid recipient email address.");
  if (!subject) throw new AppError(400, "INVALID_SUBJECT", "Subject is required.");
  if (!body) throw new AppError(400, "INVALID_BODY", "Message body is required.");

  const bodyHtml = escapeHtml(body)
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");

  await sendEmail(to, subject, renderEmailLayout({ heading: subject, bodyHtml }));
}
