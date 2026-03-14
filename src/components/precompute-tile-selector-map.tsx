"use client";

import { useEffect, useMemo, useRef } from "react";
import type { LayerGroup, Map as LeafletMap, PathOptions, Rectangle } from "leaflet";

export interface TileSelectorBbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface TileSelectorEntry {
  tileId: string;
  bbox: TileSelectorBbox;
}

interface PrecomputeTileSelectorMapProps {
  regionBbox: TileSelectorBbox;
  tiles: TileSelectorEntry[];
  selectedTileIds: string[];
  disabled?: boolean;
  onSelectionChange: (tileIds: string[]) => void;
}

function selectedStyle(isSelected: boolean): PathOptions {
  if (isSelected) {
    return {
      color: "#38bdf8",
      weight: 1,
      fillColor: "#06b6d4",
      fillOpacity: 0.22,
    };
  }
  return {
    color: "#94a3b8",
    weight: 1,
    fillColor: "#1e293b",
    fillOpacity: 0.04,
  };
}

function asBounds(bbox: TileSelectorBbox): [[number, number], [number, number]] {
  return [
    [bbox.minLat, bbox.minLon],
    [bbox.maxLat, bbox.maxLon],
  ];
}

export function PrecomputeTileSelectorMap(props: PrecomputeTileSelectorMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const rectanglesByIdRef = useRef<Map<string, Rectangle>>(new Map());
  const leafletModuleRef = useRef<typeof import("leaflet") | null>(null);
  const onSelectionChangeRef = useRef(props.onSelectionChange);
  const disabledRef = useRef(Boolean(props.disabled));
  const selectedSet = useMemo(() => new Set(props.selectedTileIds), [props.selectedTileIds]);
  const selectedSetRef = useRef(selectedSet);
  const regionMinLat = props.regionBbox.minLat;
  const regionMinLon = props.regionBbox.minLon;
  const regionMaxLat = props.regionBbox.maxLat;
  const regionMaxLon = props.regionBbox.maxLon;

  useEffect(() => {
    onSelectionChangeRef.current = props.onSelectionChange;
  }, [props.onSelectionChange]);

  useEffect(() => {
    disabledRef.current = Boolean(props.disabled);
  }, [props.disabled]);

  useEffect(() => {
    selectedSetRef.current = selectedSet;
    for (const [tileId, rectangle] of rectanglesByIdRef.current.entries()) {
      rectangle.setStyle(selectedStyle(selectedSet.has(tileId)));
    }
  }, [selectedSet]);

  useEffect(() => {
    let cancelled = false;
    const rectanglesById = rectanglesByIdRef.current;

    const init = async () => {
      if (mapRef.current || !mapContainerRef.current) {
        return;
      }
      const L = await import("leaflet");
      if (cancelled || !mapContainerRef.current) {
        return;
      }
      leafletModuleRef.current = L;
      const map = L.map(mapContainerRef.current, {
        zoomControl: true,
        maxZoom: 20,
        minZoom: 8,
      }).setView(
        [
          (regionMinLat + regionMaxLat) / 2,
          (regionMinLon + regionMaxLon) / 2,
        ],
        12,
      );
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxNativeZoom: 19,
        maxZoom: 20,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      map.fitBounds(
        asBounds({
          minLat: regionMinLat,
          minLon: regionMinLon,
          maxLat: regionMaxLat,
          maxLon: regionMaxLon,
        }),
        { padding: [10, 10] },
      );
    };

    void init();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
      }
      mapRef.current = null;
      layerRef.current = null;
      rectanglesById.clear();
      leafletModuleRef.current = null;
    };
  }, [regionMaxLat, regionMaxLon, regionMinLat, regionMinLon]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    map.fitBounds(
      asBounds({
        minLat: regionMinLat,
        minLon: regionMinLon,
        maxLat: regionMaxLat,
        maxLon: regionMaxLon,
      }),
      { padding: [10, 10] },
    );
  }, [regionMaxLat, regionMaxLon, regionMinLat, regionMinLon]);

  useEffect(() => {
    const L = leafletModuleRef.current;
    const layer = layerRef.current;
    if (!L || !layer) {
      return;
    }

    layer.clearLayers();
    rectanglesByIdRef.current.clear();

    const order = props.tiles.map((tile) => tile.tileId);
    for (const tile of props.tiles) {
      const rectangle = L.rectangle(asBounds(tile.bbox), selectedStyle(selectedSetRef.current.has(tile.tileId)));
      rectangle.bindTooltip(tile.tileId, {
        direction: "center",
        opacity: 0.8,
        sticky: true,
      });
      rectangle.on("click", () => {
        if (disabledRef.current) {
          return;
        }
        const current = selectedSetRef.current;
        const next = new Set(current);
        if (next.has(tile.tileId)) {
          next.delete(tile.tileId);
        } else {
          next.add(tile.tileId);
        }
        const orderedSelection = order.filter((tileId) => next.has(tileId));
        onSelectionChangeRef.current(orderedSelection);
      });
      rectangle.addTo(layer);
      rectanglesByIdRef.current.set(tile.tileId, rectangle);
    }
  }, [props.tiles]);

  return (
    <div className="grid gap-2">
      <div
        ref={mapContainerRef}
        className="h-80 w-full overflow-hidden rounded-xl border border-white/15 bg-slate-900/70"
      />
      <p className="text-[11px] text-slate-300">
        Clique sur une tuile pour l&apos;inclure ou l&apos;exclure du précompute.
      </p>
    </div>
  );
}
