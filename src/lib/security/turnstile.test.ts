import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TURNSTILE_COOKIE_NAME,
  isTurnstileEnabledServer,
  requireTurnstile,
} from "@/lib/security/turnstile";

/**
 * Build a minimal `Request` carrying a single `Cookie` header. We only need
 * the headers shape here — body / URL are irrelevant to `requireTurnstile`.
 */
function buildRequest(cookieHeader: string | null): Request {
  const headers = new Headers();
  if (cookieHeader !== null) {
    headers.set("cookie", cookieHeader);
  }
  return new Request("https://example.test/api/anything", { headers });
}

describe("requireTurnstile", () => {
  const previousSecret = process.env.TURNSTILE_SECRET_KEY;

  beforeEach(() => {
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.TURNSTILE_SECRET_KEY;
    } else {
      process.env.TURNSTILE_SECRET_KEY = previousSecret;
    }
  });

  it("returns ok=true when no secret is configured (dev / no-keys mode)", () => {
    const result = requireTurnstile(buildRequest(null));
    expect(result).toEqual({ ok: true });
    expect(isTurnstileEnabledServer()).toBe(false);
  });

  it("returns ok=true with secret set when the cookie is present", () => {
    process.env.TURNSTILE_SECRET_KEY = "secret-key-test";
    expect(isTurnstileEnabledServer()).toBe(true);
    const result = requireTurnstile(
      buildRequest(`${TURNSTILE_COOKIE_NAME}=1`),
    );
    expect(result).toEqual({ ok: true });
  });

  it("returns ok=false when the secret is set but no Cookie header is sent", () => {
    process.env.TURNSTILE_SECRET_KEY = "secret-key-test";
    const result = requireTurnstile(buildRequest(null));
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("missing-cookie");
    }
  });

  it("returns ok=false when the cookie is set but empty", () => {
    process.env.TURNSTILE_SECRET_KEY = "secret-key-test";
    const result = requireTurnstile(
      buildRequest(`${TURNSTILE_COOKIE_NAME}=`),
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("missing-cookie");
    }
  });

  it("returns ok=false when only an unrelated cookie is present", () => {
    process.env.TURNSTILE_SECRET_KEY = "secret-key-test";
    const result = requireTurnstile(buildRequest("other=value; another=1"));
    expect(result.ok).toBe(false);
  });

  it("parses the target cookie out of a multi-cookie header", () => {
    process.env.TURNSTILE_SECRET_KEY = "secret-key-test";
    const result = requireTurnstile(
      buildRequest(`session=abc; ${TURNSTILE_COOKIE_NAME}=1; theme=dark`),
    );
    expect(result).toEqual({ ok: true });
  });
});
