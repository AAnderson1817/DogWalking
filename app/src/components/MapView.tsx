// Route map (spec 05): Mapbox GL when VITE_MAPBOX_TOKEN is set, otherwise
// an auto-fit SVG polyline — identical props either way: { points, live? }.
// mapbox-gl loads lazily so the fallback build never pays for it.
import { useEffect, useRef, useState } from "react";
import { env } from "@/lib/env";
import { fitPointsToViewBox, toSvgPath } from "@/lib/map-fit";
import { splitOnGaps } from "@/lib/geo";

export interface MapPoint {
  lat: number;
  lng: number;
  /** Recording had stopped before this point — the line breaks here (H7). */
  gapBefore?: boolean;
}

export interface MapViewProps {
  points: MapPoint[];
  live?: boolean;
}

const VIEW_W = 320;
const VIEW_H = 200;

export function MapView({ points, live }: MapViewProps) {
  if (env.mapboxToken) {
    return <MapboxMap points={points} live={live} />;
  }
  return <SvgMap points={points} live={live} />;
}

/** SVG fallback: auto-fit polyline, start dot, live head dot. */
export function SvgMap({ points, live }: MapViewProps) {
  const fitted = fitPointsToViewBox(points, { width: VIEW_W, height: VIEW_H });
  const head = fitted[fitted.length - 1];
  const start = fitted[0];
  return (
    <div className="map-view" data-renderer="svg">
      {fitted.length === 0 ? (
        <span className="map-view__empty">No route yet</span>
      ) : (
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label="Walk route">
          <path
            d={toSvgPath(fitted)}
            fill="none"
            stroke="var(--sanpo-color-schedule-upcoming-accent)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {start && <circle cx={start.x} cy={start.y} r={4} fill="var(--sanpo-color-brand-indigo)" />}
          {head && (
            <circle
              cx={head.x}
              cy={head.y}
              r={5}
              fill={live
                ? "var(--sanpo-color-status-current)"
                : "var(--sanpo-color-status-complete)"}
              className={live ? "pulse-live" : undefined}
            />
          )}
        </svg>
      )}
    </div>
  );
}

function MapboxMap({ points, live }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  // deno-lint-ignore no-explicit-any
  const mapRef = useRef<any>(null);
  // If the lazy chunk can't load (offline cold-start after a deploy, CDN
  // hiccup), fall back to the bundled SVG map instead of a blank pane.
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (!container.current || mapRef.current) return;
      let mapboxgl: typeof import("mapbox-gl").default;
      try {
        mapboxgl = (await import("mapbox-gl")).default;
      } catch {
        if (!cancelled) setLoadFailed(true);
        return;
      }
      if (cancelled || !container.current) return;
      mapboxgl.accessToken = env.mapboxToken ?? "";
      const first = points[points.length - 1] ?? { lat: 51.5074, lng: -0.1278 };
      mapRef.current = new mapboxgl.Map({
        container: container.current,
        style: "mapbox://styles/mapbox/outdoors-v12",
        center: [first.lng, first.lat],
        zoom: 14,
        attributionControl: false,
      });
    }
    void boot();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!map || points.length === 0) return;
    const draw = () => {
      // MultiLineString, not LineString: a run of fixes either side of a
      // suspended watch is two recorded stretches, and joining them draws a
      // route across ground nobody covered (review H7).
      const segments = splitOnGaps(points).map((run) => run.map((p) => [p.lng, p.lat]));
      const data = {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "MultiLineString" as const, coordinates: segments },
      };
      const existing = map.getSource("route");
      if (existing) {
        existing.setData(data);
      } else {
        map.addSource("route", { type: "geojson", data });
        map.addLayer({
          id: "route",
          type: "line",
          source: "route",
          paint: { "line-color": "#236F86", "line-width": 4 },
        });
      }
      const setPoint = (
        id: "route-start" | "route-head",
        coordinates: [number, number],
        color: string,
        radius: number,
      ) => {
        const pointData = {
          type: "Feature" as const,
          properties: {},
          geometry: { type: "Point" as const, coordinates },
        };
        const source = map.getSource(id);
        if (source) {
          source.setData(pointData);
          return;
        }
        map.addSource(id, { type: "geojson", data: pointData });
        map.addLayer({
          id,
          type: "circle",
          source: id,
          paint: {
            "circle-color": color,
            "circle-radius": radius,
            "circle-stroke-color": "#0C4774",
            "circle-stroke-width": 1.5,
          },
        });
      };
      const firstPoint = points[0]!;
      const last = points[points.length - 1]!;
      setPoint("route-start", [firstPoint.lng, firstPoint.lat], "#0C4774", 4);
      setPoint("route-head", [last.lng, last.lat], live ? "#B84828" : "#55724B", 5);
      if (live) map.easeTo({ center: [last.lng, last.lat] });
    };
    if (map.isStyleLoaded()) draw();
    else map.once("load", draw);
  }, [points, live]);

  if (loadFailed) return <SvgMap points={points} live={live} />;
  return <div className="map-view" data-renderer="mapbox" ref={container} />;
}
