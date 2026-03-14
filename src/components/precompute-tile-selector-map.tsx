"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LayerGroup,
  LeafletMouseEvent,
  Map as LeafletMap,
  PathOptions,
  Rectangle,
} from "leaflet";

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
  fullscreen?: boolean;
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

function bboxIntersects(left: TileSelectorBbox, right: TileSelectorBbox): boolean {
  return !(
    left.maxLon < right.minLon ||
    left.minLon > right.maxLon ||
    left.maxLat < right.minLat ||
    left.minLat > right.maxLat
  );
}

function normalizeBboxFromPoints(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number },
): TileSelectorBbox {
  return {
    minLon: Math.min(start.lon, end.lon),
    minLat: Math.min(start.lat, end.lat),
    maxLon: Math.max(start.lon, end.lon),
    maxLat: Math.max(start.lat, end.lat),
  };
}

export function PrecomputeTileSelectorMap(props: PrecomputeTileSelectorMapProps) {
  const [mapReady, setMapReady] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const rectanglesByIdRef = useRef<Map<string, Rectangle>>(new Map());
  const leafletModuleRef = useRef<typeof import("leaflet") | null>(null);
  const onSelectionChangeRef = useRef(props.onSelectionChange);
  const disabledRef = useRef(Boolean(props.disabled));
  const selectedSet = useMemo(() => new Set(props.selectedTileIds), [props.selectedTileIds]);
  const selectedSetRef = useRef(selectedSet);
  const dragStartRef = useRef<{ lat: number; lon: number } | null>(null);
  const dragRectangleRef = useRef<Rectangle | null>(null);
  const suppressNextTileClickRef = useRef(false);
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
      setMapReady(true);
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
      setMapReady(false);
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
  }, [mapReady, regionMaxLat, regionMaxLon, regionMinLat, regionMinLon]);

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
      rectangle.on("click", (event: LeafletMouseEvent) => {
        if (disabledRef.current) {
          return;
        }
        if (suppressNextTileClickRef.current) {
          suppressNextTileClickRef.current = false;
          return;
        }
        const rawEvent = event.originalEvent as MouseEvent;
        const isRemoveAction = rawEvent.altKey;
        const current = selectedSetRef.current;
        const next = new Set(current);
        if (isRemoveAction) {
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
  }, [mapReady, props.tiles]);

  useEffect(() => {
    const L = leafletModuleRef.current;
    const map = mapRef.current;
    if (!L || !map) {
      return;
    }

    const clearDragRectangle = () => {
      if (dragRectangleRef.current) {
        map.removeLayer(dragRectangleRef.current);
        dragRectangleRef.current = null;
      }
    };

    const onMouseDown = (event: LeafletMouseEvent) => {
      if (disabledRef.current) {
        return;
      }
      const mouseEvent = event.originalEvent as MouseEvent;
      if (mouseEvent.button !== 0) {
        return;
      }
      if (mouseEvent.altKey) {
        return;
      }
      const start = { lat: event.latlng.lat, lon: event.latlng.lng };
      dragStartRef.current = start;
      clearDragRectangle();
      dragRectangleRef.current = L.rectangle(
        asBounds(
          normalizeBboxFromPoints(start, start),
        ),
        {
          color: "#f59e0b",
          weight: 1,
          fillColor: "#f59e0b",
          fillOpacity: 0.1,
          dashArray: "4 4",
          interactive: false,
        },
      ).addTo(map);
      map.dragging.disable();
    };

    const onMouseMove = (event: LeafletMouseEvent) => {
      if (!dragStartRef.current || !dragRectangleRef.current) {
        return;
      }
      const current = { lat: event.latlng.lat, lon: event.latlng.lng };
      dragRectangleRef.current.setBounds(asBounds(normalizeBboxFromPoints(dragStartRef.current, current)));
    };

    const onMouseUp = (event: LeafletMouseEvent) => {
      if (!dragStartRef.current) {
        return;
      }
      const start = dragStartRef.current;
      const end = { lat: event.latlng.lat, lon: event.latlng.lng };
      dragStartRef.current = null;

      map.dragging.enable();

      const selectionBbox = normalizeBboxFromPoints(start, end);
      const movedEnough =
        Math.abs(end.lat - start.lat) > 0.00005 ||
        Math.abs(end.lon - start.lon) > 0.00005;
      clearDragRectangle();
      if (!movedEnough) {
        return;
      }

      const next = new Set(selectedSetRef.current);
      let added = false;
      for (const tile of props.tiles) {
        if (bboxIntersects(tile.bbox, selectionBbox)) {
          if (!next.has(tile.tileId)) {
            next.add(tile.tileId);
            added = true;
          }
        }
      }
      if (added) {
        const orderedSelection = props.tiles
          .map((tile) => tile.tileId)
          .filter((tileId) => next.has(tileId));
        onSelectionChangeRef.current(orderedSelection);
      }
      suppressNextTileClickRef.current = true;
    };

    map.on("mousedown", onMouseDown);
    map.on("mousemove", onMouseMove);
    map.on("mouseup", onMouseUp);

    return () => {
      map.off("mousedown", onMouseDown);
      map.off("mousemove", onMouseMove);
      map.off("mouseup", onMouseUp);
      map.dragging.enable();
      clearDragRectangle();
      dragStartRef.current = null;
    };
  }, [mapReady, props.tiles]);

  return (
    <div className={props.fullscreen ? "flex min-h-0 flex-1 flex-col gap-2" : "grid gap-2"}>
      <div
        ref={mapContainerRef}
        data-testid="precompute-tile-selector-map"
        className={`w-full overflow-hidden rounded-xl border border-white/15 bg-slate-900/70 ${
          props.fullscreen ? "min-h-0 flex-1" : "h-80"
        }`}
      />
      <p className="text-[11px] text-slate-300">
        Clique pour ajouter une tuile. `Alt + clic` retire une tuile. Glisser-déposer ajoute un rectangle de tuiles.
      </p>
    </div>
  );
}
