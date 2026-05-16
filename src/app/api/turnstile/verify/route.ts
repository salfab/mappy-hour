import { NextResponse } from "next/server";
import { z } from "zod";

import {
  TURNSTILE_COOKIE_NAME,
  isTurnstileEnabledServer,
} from "@/lib/security/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** 30 minutes — matches the cookie max-age. Shorter than Turnstile's own
 *  token lifetime (~5 min) is on purpose: we re-issue the cookie much later
 *  than the underlying token expires. */
const COOKIE_MAX_AGE_SECONDS = 30 * 60;

/** Hard timeout on the upstream siteverify call. Cloudflare normally answers
 *  in <100ms; 5s lets us cover one TCP retry without making the user wait
 *  longer than a typical SSR fetch deadline. */
const SITEVERIFY_TIMEOUT_MS = 5000;

const bodySchema = z.object({
  token: z.string().min(1).max(2048),
});

interface SiteVerifyResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}

export async function POST(request: Request) {
  // No-op mode: when the operator hasn't provisioned a secret we don't gate
  // anything, so we don't need to verify tokens either. Return 200 so the
  // client treats the call as a success and doesn't keep retrying.
  if (!isTurnstileEnabledServer()) {
    return NextResponse.json({ ok: true, mode: "disabled" });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid-body" },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid-body" },
      { status: 400 },
    );
  }

  const secret = process.env.TURNSTILE_SECRET_KEY!;
  const remoteIp = readClientIp(request);

  let verification: SiteVerifyResponse | null = null;
  // One retry on network/timeout (Cloudflare edge can hiccup on cold POPs).
  // Any HTTP 4xx/5xx skips the retry — repeating won't help.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      verification = await callSiteVerify({
        token: parsed.data.token,
        secret,
        remoteIp,
      });
      break;
    } catch (err) {
      const isLast = attempt === 1;
      process.stderr.write(
        `[turnstile/verify] siteverify call failed (attempt ${attempt + 1}/2): ${
          err instanceof Error ? err.message : String(err)
        }${isLast ? " — giving up" : " — retrying"}\n`,
      );
      if (isLast) {
        return NextResponse.json(
          { ok: false, error: "siteverify-unreachable" },
          { status: 502 },
        );
      }
    }
  }

  if (!verification || !verification.success) {
    const errorCodes = verification?.["error-codes"] ?? [];
    process.stderr.write(
      `[turnstile/verify] token rejected; error-codes=${JSON.stringify(errorCodes)}\n`,
    );
    return NextResponse.json(
      { ok: false, error: "token-rejected", details: errorCodes },
      { status: 400 },
    );
  }

  // We trust same-origin deployments to drive both HTTP and HTTPS; `secure`
  // is only meaningful in production. `request.url` is preserved through
  // Next's standalone runtime so checking the protocol is reliable.
  const url = new URL(request.url);
  const secure =
    url.protocol === "https:" || url.hostname !== "localhost";

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: TURNSTILE_COOKIE_NAME,
    value: "1",
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

function readClientIp(request: Request): string | undefined {
  // Standard proxy chain — Cloudflare/Tailscale Funnel populate one of these.
  // Falls back to undefined; Turnstile accepts requests without `remoteip`.
  const candidates = [
    request.headers.get("cf-connecting-ip"),
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    request.headers.get("x-real-ip"),
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.length > 0) return candidate;
  }
  return undefined;
}

async function callSiteVerify(params: {
  token: string;
  secret: string;
  remoteIp: string | undefined;
}): Promise<SiteVerifyResponse> {
  const form = new URLSearchParams();
  form.set("secret", params.secret);
  form.set("response", params.token);
  if (params.remoteIp) {
    form.set("remoteip", params.remoteIp);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`siteverify HTTP ${res.status}`);
    }
    return (await res.json()) as SiteVerifyResponse;
  } finally {
    clearTimeout(timer);
  }
}
