import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../../db.js";

/**
 * Verifies a Resend (Svix) webhook signature. Resend signs every webhook with Svix: the signed
 * content is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256'd with the base64 portion of the
 * `whsec_...` secret, and the `svix-signature` header is a space-separated list of
 * `v1,<base64sig>` entries (there can be more than one during secret rotation — a match on any
 * is a pass). Implemented directly rather than pulling in the `svix` package for ~15 lines.
 */
export function verifySvixSignature(input: {
  secret: string;
  id: string;
  timestamp: string;
  signatureHeader: string;
  rawBody: string;
}): boolean {
  const { secret, id, timestamp, signatureHeader, rawBody } = input;
  if (!id || !timestamp || !signatureHeader) return false;

  // Reject implausible timestamps (>5 min skew) — standard Svix replay guard.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${rawBody}`).digest();

  return signatureHeader
    .split(" ")
    .map((part) => part.split(",")[1] ?? "")
    .some((sig) => {
      if (!sig) return false;
      const got = Buffer.from(sig, "base64");
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
}

// "Display Name <addr@host>" | "addr@host" | { name, address } | { name, email } -> parts.
function parseAddress(value: unknown): { address: string; name: string | null } {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const address = String(obj.address ?? obj.email ?? "");
    const name = obj.name != null ? String(obj.name) : null;
    return { address, name };
  }
  const str = String(value ?? "").trim();
  const angle = str.match(/^(.*?)\s*<([^>]+)>$/);
  if (angle) {
    const name = angle[1]!.replace(/^"|"$/g, "").trim();
    return { address: angle[2]!.trim(), name: name || null };
  }
  return { address: str, name: null };
}

function firstAddress(value: unknown): { address: string; name: string | null } {
  if (Array.isArray(value)) return parseAddress(value[0]);
  if (typeof value === "string" && value.includes(",")) return parseAddress(value.split(",")[0]);
  return parseAddress(value);
}

// Headers arrive either as [{ name, value }, ...] or as a plain { name: value } object.
function normalizeHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const h of value) {
      if (h && typeof h === "object") {
        const name = (h as Record<string, unknown>).name;
        const val = (h as Record<string, unknown>).value;
        if (name != null) out[String(name)] = String(val ?? "");
      }
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = String(v ?? "");
  }
  return out;
}

function pickHeader(headers: Record<string, string>, name: string): string | undefined {
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return hit?.[1];
}

/**
 * Persists one inbound message. Defensive about the exact payload shape (Resend's inbound
 * feature is young and the field names have moved around) — reads `body.data` if present,
 * otherwise the body itself, and tolerates both string and object address/header forms.
 *
 * Returns whether a row was actually inserted (false = duplicate Message-ID, already stored).
 */
export async function storeInboundEmail(body: unknown): Promise<boolean> {
  const root = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;

  const from = firstAddress(data.from ?? data.sender ?? data.from_address);
  const to = firstAddress(data.to ?? data.recipient ?? data.to_address);
  const headers = normalizeHeaders(data.headers);

  const messageId =
    (typeof data.message_id === "string" && data.message_id) ||
    (typeof data.messageId === "string" && data.messageId) ||
    pickHeader(headers, "Message-ID") ||
    pickHeader(headers, "Message-Id") ||
    null;

  const subject = data.subject != null ? String(data.subject) : null;
  const textBody =
    data.text != null ? String(data.text) : data.text_body != null ? String(data.text_body) : null;
  const htmlBody =
    data.html != null ? String(data.html) : data.html_body != null ? String(data.html_body) : null;

  const receivedRaw = data.created_at ?? root.created_at ?? data.date;
  const receivedAt = receivedRaw ? new Date(String(receivedRaw)) : new Date();

  try {
    await db.received_emails.create({
      data: {
        message_id: messageId,
        from_address: from.address || "(unknown)",
        from_name: from.name,
        to_address: to.address || "(unknown)",
        subject,
        text_body: textBody,
        html_body: htmlBody,
        headers,
        raw: (body ?? {}) as object,
        received_at: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
      },
    });
    return true;
  } catch (err) {
    // Unique violation on message_id => Resend redelivered a message we already stored. That's a
    // success from the webhook's point of view (return 2xx so Resend stops retrying).
    if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") return false;
    throw err;
  }
}

export async function listReceivedEmails(limit = 200) {
  const rows = await db.received_emails.findMany({
    orderBy: { received_at: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    fromAddress: r.from_address,
    fromName: r.from_name,
    toAddress: r.to_address,
    subject: r.subject,
    textBody: r.text_body,
    htmlBody: r.html_body,
    receivedAt: r.received_at.toISOString(),
  }));
}
