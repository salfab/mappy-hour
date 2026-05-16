# Bot filtering with Cloudflare Turnstile

`mappyhour.ch` receives a steady stream of crawler traffic (most of it from
outside Switzerland, with Umami reporting zero interaction events). Each
HTML hit triggers a `/api/sunlight/timeline/stream` SSE call plus several
`/api/places/viewport` POSTs — all of which are heavy on Mitch (the prod
NUC). To filter that noise we mount an **invisible** Cloudflare Turnstile
widget on every page and gate the expensive endpoints behind a successful
challenge.

## Architecture

1. `<TurnstileGate />` is rendered from `src/app/layout.tsx`. On mount it
   injects `https://challenges.cloudflare.com/turnstile/v0/api.js` and
   renders a hidden widget in `size: "invisible"`, `appearance: "execute"`.
2. When Cloudflare issues a token, the widget callback POSTs it to
   `/api/turnstile/verify` (`src/app/api/turnstile/verify/route.ts`).
3. The endpoint calls `https://challenges.cloudflare.com/turnstile/v0/siteverify`
   with the project secret. On success it sets the HttpOnly, `SameSite=Lax`,
   `Secure` (in prod) cookie `mh-turnstile-ok=1` with a 30-minute max-age.
4. The gated routes — `timeline/stream`, `instant/stream`, `places/viewport`
   — call `requireTurnstile(request)` (`src/lib/security/turnstile.ts`).
   When the cookie is absent they return `403 { error: "turnstile-required" }`.

## Endpoints

| Path | Gated? | Why |
|---|---|---|
| `/api/sunlight/timeline/stream` | yes | Heavy CPU; multiplied by every page load |
| `/api/sunlight/instant/stream` | yes | Heavy CPU; not used in cache-only prod but still gated |
| `/api/places/viewport` | yes | Multiple calls per pan/zoom |
| `/api/turnstile/verify` | no | Issues the cookie — gating it would deadlock |
| `/api/datasets`, `/api/admin/*` | no | Cheap / operator-only |
| All other places / geocode / point / area | no | Lower-traffic, less wasteful for now |

## Dev / no-keys mode

If **either** `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (client) **or**
`TURNSTILE_SECRET_KEY` (server) is missing, the gate is a no-op:

- The client component returns `null` — no script, no widget mounted.
- `requireTurnstile` returns `{ ok: true }` for every request.
- `/api/turnstile/verify` responds 200 with `mode: "disabled"` without
  contacting Cloudflare.

This lets every dev branch / preview build run without provisioning anything.

## Provisioning keys

1. Open <https://dash.cloudflare.com/?to=/:account/turnstile> and create a
   widget. Domain: `mappyhour.ch` (and any preview domains used). Widget
   mode: **Managed** is fine — we render it in invisible mode in the JS
   options anyway, which lets Cloudflare upgrade to a visible interstitial
   on suspicious traffic.
2. Copy the **site key** into `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and the
   **secret key** into `TURNSTILE_SECRET_KEY`. See `.env.example`.
3. On Mitch: set both env vars in the systemd unit / docker-compose env
   block, restart the container. The gate flips on automatically — no code
   change needed.

## Verifying it works

1. From a browser with JS enabled, load `/` → DevTools → Application →
   Cookies. After a second or two `mh-turnstile-ok=1` should appear.
2. `curl https://mappyhour.ch/api/sunlight/timeline/stream?...` should
   return `403 { "error": "turnstile-required", "reason": "missing-cookie" }`.
3. Hit the same URL from a real browser session — it should stream as
   usual.
