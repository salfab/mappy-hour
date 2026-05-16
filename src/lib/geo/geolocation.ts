/**
 * Browser geolocation helpers for first-load map centering.
 *
 * On the first visit (no stored map view), we ask the browser for the user's
 * coordinates and — if they land inside a supported region — center the map
 * on their neighborhood. Refusal / unavailability / out-of-region all fall
 * back to the existing default center (Lausanne).
 *
 * The user's choice is persisted in `localStorage` so we do not re-prompt on
 * subsequent visits. The Permissions API is queried first when available so
 * we can short-circuit when the user has already denied the permission at the
 * browser level (no prompt is shown in that case — `getCurrentPosition` would
 * fail immediately anyway, but querying upfront avoids the latency).
 *
 * No IP-based fallback is intentional: it is too intrusive for the gain.
 */

import {
  findContainingPrecomputedRegion,
  type PrecomputedRegionName,
} from "@/lib/precompute/sunlight-cache";

/**
 * localStorage key recording the user's prior geolocation decision so we do
 * not nag them on every visit. Values: `"granted"` (we got a position at
 * least once and may auto-refresh on next mount) | `"refused"` (user denied
 * either via the native prompt or implicitly via the Permissions API).
 */
export const GEOLOCATION_DECISION_STORAGE_KEY = "mappy-hour:geoloc-decision";

/** Possible persisted decisions. */
export type StoredGeolocationDecision = "granted" | "refused";

/** Default timeout for `getCurrentPosition`. 8s is the browser sweet-spot
 *  observed in practice — long enough for cold GPS on mobile, short enough
 *  that we do not block the first paint indefinitely. */
const DEFAULT_TIMEOUT_MS = 8_000;

/** Reason taxonomy for failed / non-actionable geoloc attempts. Mapped 1:1
 *  to `GeolocationPositionError.code` plus our own out-of-region case. */
export type GeolocationFailureReason =
  | "stored-refuse"
  | "permissions-denied"
  | "user-denied"
  | "unavailable"
  | "timeout"
  | "out-of-region"
  | "no-browser-api";

export interface GeolocationOutcome {
  /** `true` iff we obtained a position AND it lies inside a supported region. */
  granted: boolean;
  /** Position in WGS84, or `null` if we did not get one. */
  position: { lat: number; lon: number } | null;
  /** When `granted` is `true`, the region the position lands in. Otherwise null. */
  region: PrecomputedRegionName | null;
  /** Failure / refusal reason. `null` only when `granted` is `true`. */
  reason: GeolocationFailureReason | null;
}

/** Read the user's prior decision from localStorage. Returns `null` if no
 *  decision was stored yet OR if storage is unavailable / corrupted. */
export function readStoredGeolocationDecision(): StoredGeolocationDecision | null {
  try {
    const raw = globalThis.localStorage?.getItem(GEOLOCATION_DECISION_STORAGE_KEY);
    if (raw === "granted" || raw === "refused") return raw;
    return null;
  } catch {
    return null;
  }
}

/** Persist the user's decision. Silent on storage errors (quota, private
 *  mode) — geolocation is opt-in and best-effort by design. */
export function writeStoredGeolocationDecision(decision: StoredGeolocationDecision): void {
  try {
    globalThis.localStorage?.setItem(GEOLOCATION_DECISION_STORAGE_KEY, decision);
  } catch {
    // ignore
  }
}

/** Returns `true` iff `(lat, lon)` falls inside the bounding box of any
 *  supported region. Convenience re-export so callers do not have to import
 *  from the precompute layer directly. */
export function isInSupportedRegion(lat: number, lon: number): boolean {
  return findContainingPrecomputedRegion(lat, lon) !== null;
}

/** Map a `GeolocationPositionError.code` to our reason taxonomy. */
function failureReasonFromError(error: GeolocationPositionError): GeolocationFailureReason {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return "user-denied";
    case error.POSITION_UNAVAILABLE:
      return "unavailable";
    case error.TIMEOUT:
      return "timeout";
    default:
      return "unavailable";
  }
}

/**
 * Request the user's geolocation. Honors the persisted decision (re-prompt
 * only when none is stored, OR when the caller explicitly asks for it via
 * `force`). When successful, also updates the stored decision so subsequent
 * mounts skip the prompt round-trip.
 *
 * Always resolves — never throws — so callers can `await` it inline in a
 * mount effect without try/catch.
 *
 * @param options.timeoutMs   How long to wait for a position before giving up.
 *                            Default: 8000 ms.
 * @param options.force       Bypass the persisted decision check. Used by the
 *                            "Me localiser" button so the user can change
 *                            their mind. Default: `false`.
 * @param options.persistDecision  Whether to write to localStorage after this
 *                                  call. Default: `true`.
 */
export async function requestUserGeolocation(
  options: { timeoutMs?: number; force?: boolean; persistDecision?: boolean } = {},
): Promise<GeolocationOutcome> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, force = false, persistDecision = true } = options;

  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return { granted: false, position: null, region: null, reason: "no-browser-api" };
  }

  if (!force) {
    const stored = readStoredGeolocationDecision();
    if (stored === "refused") {
      return { granted: false, position: null, region: null, reason: "stored-refuse" };
    }
  }

  // Permissions API short-circuit. Not all browsers expose it (older Safari);
  // when missing, we fall straight through to `getCurrentPosition`. When it
  // says "denied", `getCurrentPosition` would also fail — but Permissions API
  // returns sync-fast, whereas `getCurrentPosition` may stall for `timeoutMs`
  // on some hardware before erroring out.
  try {
    const permissions = (navigator as Navigator & {
      permissions?: { query: (descriptor: { name: string }) => Promise<PermissionStatus> };
    }).permissions;
    if (permissions && typeof permissions.query === "function") {
      const status = await permissions.query({ name: "geolocation" });
      if (status.state === "denied") {
        if (persistDecision) writeStoredGeolocationDecision("refused");
        return { granted: false, position: null, region: null, reason: "permissions-denied" };
      }
    }
  } catch {
    // Permissions API not supported / errored — proceed with getCurrentPosition.
  }

  const position = await new Promise<GeolocationPosition | GeolocationPositionError>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      (err) => resolve(err),
      { timeout: timeoutMs, enableHighAccuracy: false, maximumAge: 5 * 60_000 },
    );
  });

  if ("code" in position && typeof position.code === "number") {
    const reason = failureReasonFromError(position as GeolocationPositionError);
    if (persistDecision && reason === "user-denied") {
      writeStoredGeolocationDecision("refused");
    }
    return { granted: false, position: null, region: null, reason };
  }

  const coords = (position as GeolocationPosition).coords;
  const lat = coords.latitude;
  const lon = coords.longitude;
  const region = findContainingPrecomputedRegion(lat, lon);

  if (persistDecision) writeStoredGeolocationDecision("granted");

  if (region === null) {
    return {
      granted: false,
      position: { lat, lon },
      region: null,
      reason: "out-of-region",
    };
  }

  return { granted: true, position: { lat, lon }, region, reason: null };
}
