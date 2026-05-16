/**
 * Server-side gate for Cloudflare Turnstile.
 *
 * The page mounts the Turnstile widget client-side; on success the client POSTs
 * the issued token to `/api/turnstile/verify`, which calls Cloudflare's
 * `siteverify` endpoint and sets the `mh-turnstile-ok` cookie when the token
 * is accepted. Routes that should only serve real users (expensive SSE
 * endpoints, viewport places) call `requireTurnstile` at the top of their
 * handler and bail out with a 403 when the cookie is absent.
 *
 * Why a cookie indicator and not the raw token: the token is one-shot at
 * Cloudflare's side, so we can't replay it from the server when the SSE
 * connection lands. The cookie is HttpOnly and only `/api/turnstile/verify`
 * can issue it, so its presence is a sufficient proof that the visitor's
 * browser executed the Turnstile JS once in the last 30 minutes.
 *
 * Dev mode (no keys provisioned): when `TURNSTILE_SECRET_KEY` is unset we
 * return `{ ok: true }` unconditionally. This keeps local development frictionless
 * and matches the client-side bypass (no widget mounted when the public site
 * key is missing). The behaviour is documented in `docs/security/turnstile.md`.
 */
export const TURNSTILE_COOKIE_NAME = "mh-turnstile-ok";

export interface TurnstileCheckOk {
  ok: true;
}

export interface TurnstileCheckFail {
  ok: false;
  reason: string;
}

export type TurnstileCheck = TurnstileCheckOk | TurnstileCheckFail;

/**
 * True when the server is configured to enforce Turnstile. When false the
 * verify endpoint and the gates are no-ops, which is what we want in dev /
 * any deployment that hasn't provisioned Cloudflare keys yet.
 */
export function isTurnstileEnabledServer(): boolean {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  return typeof secret === "string" && secret.trim().length > 0;
}

/**
 * Gate for API routes. Reads the `mh-turnstile-ok` cookie from the request
 * `Cookie` header. We deliberately do not import `next/headers`'s `cookies()`
 * helper here — it requires the dynamic-cookie context that route handlers
 * have, but parsing the request `Cookie` header directly keeps this function
 * free of Next-internal coupling and trivially unit-testable.
 */
export function requireTurnstile(request: Request): TurnstileCheck {
  if (!isTurnstileEnabledServer()) {
    return { ok: true };
  }
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return { ok: false, reason: "missing-cookie" };
  }
  const value = readCookie(cookieHeader, TURNSTILE_COOKIE_NAME);
  if (!value || value.trim().length === 0) {
    return { ok: false, reason: "missing-cookie" };
  }
  return { ok: true };
}

/**
 * Tiny cookie-header parser. We avoid a dependency for two reasons:
 *   1) we only read a single boolean indicator (presence/value), not a full
 *      cookie jar with attributes — `cookie` / `tough-cookie` would be overkill;
 *   2) the value we set is always the literal "1", so we don't need
 *      RFC 6265-strict unescaping.
 */
function readCookie(cookieHeader: string, name: string): string | null {
  const parts = cookieHeader.split(";");
  for (const raw of parts) {
    const trimmed = raw.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (key !== name) continue;
    return trimmed.slice(eq + 1);
  }
  return null;
}
