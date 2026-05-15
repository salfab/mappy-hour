export const MAP_VIEW_STORAGE_KEY = "mappy-hour:map:view";
export const MAP_MAX_ZOOM = 20;

export interface StoredMapView {
  lat: number;
  lon: number;
  zoom: number;
}

export function loadStoredMapView(): StoredMapView | null {
  try {
    const raw = globalThis.localStorage?.getItem(MAP_VIEW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredMapView>;
    const { lat, lon, zoom } = parsed;
    if (
      typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180 ||
      typeof zoom !== "number" || !Number.isFinite(zoom) || zoom < 0 || zoom > MAP_MAX_ZOOM
    ) {
      return null;
    }
    return { lat, lon, zoom };
  } catch {
    return null;
  }
}

export function persistMapView(view: StoredMapView): void {
  try {
    globalThis.localStorage?.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage errors (private mode, quota) are silently ignored.
  }
}
