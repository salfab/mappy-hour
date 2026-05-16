/**
 * Client-side "Turnstile is ready" signal.
 *
 * The Cloudflare Turnstile widget runs an async background challenge as soon
 * as the page mounts (cf. `<TurnstileGate>`). Until that challenge completes
 * AND its token has been POSTed to `/api/turnstile/verify`, the
 * `mh-turnstile-ok` HttpOnly cookie does not exist on this origin yet, and
 * any same-origin call to a gated route (`/api/sunlight/timeline/stream`,
 * `/api/sunlight/instant/stream`, `/api/places/viewport`) is rejected with
 * a 403 `missing-cookie`.
 *
 * The flag below lets the rest of the app coordinate: it flips from `false`
 * to `true` exactly once — when `/api/turnstile/verify` returns 200 (or
 * immediately, in dev/no-keys mode where the gate is short-circuited).
 *
 * Why a global flag and not React context: the widget lives in the root
 * layout and most consumers are React components, but a few legacy or
 * imperative call sites (event handlers, EventSource setup) want to read it
 * outside the render path. A single `globalThis`-anchored slot keyed by a
 * shared Symbol is the same pattern used for `active-sse.ts` and
 * `cpu-warnings.ts` — HMR-safe and trivially shared across modules.
 *
 * Symbol namespacing
 * ------------------
 * We use `Symbol.for("mh.turnstile.ready")` so a hot-reload of either
 * `<TurnstileGate>` or a consumer module hits the same slot. Slightly
 * different from the `mappyhour.observability.*` keys used elsewhere; both
 * conventions are fine for `Symbol.for` (registry-global), and the shorter
 * `mh.*` prefix here is documented in this comment so future readers don't
 * try to "fix" it.
 *
 * Server-side rendering
 * ---------------------
 * On the server `globalThis` is shared across requests, but we only ever
 * read the flag — and the flag is *only* written from the browser. Defaulting
 * `ready` to `false` in SSR is correct: gated fetches must not be issued
 * during SSR (none of them are anyway, but the contract is explicit).
 */

const GLOBAL_KEY = Symbol.for("mh.turnstile.ready");

interface TurnstileReadyRegistry {
  ready: boolean;
  promise: Promise<void>;
  resolve: () => void;
}

interface GlobalWithRegistry {
  [GLOBAL_KEY]?: TurnstileReadyRegistry;
}

function getRegistry(): TurnstileReadyRegistry {
  const slot = globalThis as GlobalWithRegistry;
  let registry = slot[GLOBAL_KEY];
  if (!registry) {
    // `withResolvers`-style deferred — assigning `resolve` from inside the
    // executor lets us trigger the promise externally when `markReady()`
    // is called. The promise is created exactly once per process and is
    // never replaced (so consumers can cache `getTurnstileReadyPromise()`
    // without worrying about a stale handle after a reload).
    let resolver: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    registry = { ready: false, promise, resolve: resolver };
    slot[GLOBAL_KEY] = registry;
  }
  return registry;
}

/**
 * Synchronous read of the current ready state. Returns `false` until the
 * verify endpoint has accepted the Turnstile token (or until `markReady()`
 * is called directly in dev/no-keys mode).
 */
export function isTurnstileReady(): boolean {
  return getRegistry().ready;
}

/**
 * Returns a promise that resolves the *first* time the gate flips to ready.
 * The promise is shared across callers (same instance for every call) and
 * never rejects — failures stay silent and keep the gate in the `false`
 * state so the UI surfaces the disabled affordance.
 */
export function getTurnstileReadyPromise(): Promise<void> {
  return getRegistry().promise;
}

/**
 * Custom-event name used to broadcast readiness to listeners that prefer a
 * DOM event over reading the flag. Dispatched on `window` exactly once per
 * page lifecycle, immediately after the flag flips to `true`.
 */
export const TURNSTILE_READY_EVENT = "mh:turnstile-ready";

/**
 * Mark the gate as ready. Idempotent — a second call is a no-op (the flag
 * stays `true`, the promise stays resolved). Safe to call from anywhere in
 * the browser; on the server it still works (no `window` access) but no
 * event is dispatched.
 */
export function markTurnstileReady(): void {
  const registry = getRegistry();
  if (registry.ready) return;
  registry.ready = true;
  registry.resolve();
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(TURNSTILE_READY_EVENT));
    } catch {
      // `CustomEvent` may not exist in some test polyfills — the flag is
      // already set, so consumers using the polling/promise paths still
      // work even if the event dispatch silently fails.
    }
  }
}
