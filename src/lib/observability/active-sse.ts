/**
 * Process-wide counter of in-flight expensive routes — currently the two SSE
 * streams (`/api/sunlight/timeline/stream`, `/api/sunlight/instant/stream`)
 * and the `/api/places/viewport` POST handler. Used by the `/api/admin/diag/
 * system` endpoint (and the `?debug-cpu=1` overlay) to correlate a CPU spike
 * with the number of concurrent heavy requests.
 *
 * The counter is intentionally process-local and unauthenticated: it is a
 * coarse diagnostic signal, not a security control. A surge of 15 concurrent
 * timeline streams on Mitch is interesting; the precise identity of the
 * callers is not — bots are filtered upstream by Turnstile.
 *
 * Globals & HMR safety
 * --------------------
 * Next dev runs route handlers through HMR: every edit to a route module
 * re-evaluates that module, so any plain top-level `const counts = new Map`
 * would be reset, which would in turn produce a counter that drifts
 * relative to in-flight streams started before the reload. Stashing the
 * map under a well-known symbol on `globalThis` survives HMR because the
 * `globalThis` object is the same instance across reloads.
 *
 * Concurrency
 * -----------
 * Node.js Next runtime is single-threaded JS, so we don't need a lock
 * around the increment/decrement pair: the operations are atomic from the
 * perspective of the event loop. The only contract we need to enforce at
 * call sites is "every `increment` is paired with a `decrement` in a
 * try/finally" — see the SSE route wrappers.
 */

const GLOBAL_KEY = Symbol.for("mappyhour.observability.activeSse");

interface ActiveSseRegistry {
  counts: Map<string, number>;
}

interface GlobalWithRegistry {
  [GLOBAL_KEY]?: ActiveSseRegistry;
}

function getRegistry(): ActiveSseRegistry {
  const slot = globalThis as GlobalWithRegistry;
  let registry = slot[GLOBAL_KEY];
  if (!registry) {
    registry = { counts: new Map<string, number>() };
    slot[GLOBAL_KEY] = registry;
  }
  return registry;
}

/**
 * Mark one in-flight request for `routeId`. Must be paired with a matching
 * `decrement` in a try/finally (or stream `finally` block) so the counter
 * cannot drift on abort, exception, or unexpected return path.
 */
export function increment(routeId: string): void {
  const { counts } = getRegistry();
  counts.set(routeId, (counts.get(routeId) ?? 0) + 1);
}

/**
 * Mark one completed (or aborted) request for `routeId`. Floors at 0 so an
 * accidental double-decrement during refactors doesn't produce a negative
 * counter that would underflow downstream consumers.
 */
export function decrement(routeId: string): void {
  const { counts } = getRegistry();
  const next = (counts.get(routeId) ?? 0) - 1;
  if (next <= 0) {
    counts.delete(routeId);
  } else {
    counts.set(routeId, next);
  }
}

export interface ActiveSseSnapshot {
  total: number;
  byRoute: Record<string, number>;
}

/**
 * Snapshot of every tracked route. Used by the diag endpoint to surface
 * per-route counts (e.g. `t:2 v:1`) and by the warning rule to decide
 * whether the current CPU pressure is correlated with SSE load.
 */
export function getActiveCount(): ActiveSseSnapshot {
  const { counts } = getRegistry();
  const byRoute: Record<string, number> = {};
  let total = 0;
  for (const [routeId, n] of counts) {
    if (n > 0) {
      byRoute[routeId] = n;
      total += n;
    }
  }
  return { total, byRoute };
}

/**
 * Drop every tracked count back to zero. Test-only helper exposed so unit
 * tests don't have to import `@vitest/utils` for module re-evaluation.
 */
export function __resetForTests(): void {
  const { counts } = getRegistry();
  counts.clear();
}
