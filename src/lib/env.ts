// Pure parsers for environment settings — kept out of src/config.ts (which reads required env vars
// at import time) so they can be unit-tested directly.

/**
 * Fastify's trustProxy: which upstream hops' X-Forwarded-For to believe when deciding request.ip
 * (the key for every per-IP rate limit). Every browser request reaches the backend through the
 * Next.js proxy, so without trusting it every client looks like the frontend container and they
 * all share ONE rate-limit bucket (one attacker could lock everyone out of login). The default
 * trusts private-network/loopback hops only — correct behind Next plus an appending reverse proxy
 * or tunnel (Cloudflare, nginx). "false" disables, "true" trusts any hop, a number trusts that many
 * hops, anything else is passed through (IPs/CIDRs/proxy-addr names).
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === "") return "loopback,linklocal,uniquelocal";
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Whether cookies get the Secure attribute. A Secure cookie is silently dropped by browsers on a
 * plain-HTTP origin other than localhost — login would appear to work and then lose the session —
 * so the default follows the scheme of the app's public URL. COOKIE_SECURE overrides it either way
 * (e.g. "true" behind a TLS-terminating proxy whose PUBLIC_APP_URL is still being set up).
 */
export function resolveCookieSecure(cookieSecure: string | undefined, publicAppUrl: string): boolean {
  if (cookieSecure === "true") return true;
  if (cookieSecure === "false") return false;
  return publicAppUrl.toLowerCase().startsWith("https://");
}
