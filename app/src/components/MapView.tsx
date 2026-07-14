// Route map (spec 05): Mapbox GL when VITE_MAPBOX_TOKEN is set, otherwise
// an auto-fit SVG polyline — identical props either way: { points, live? }.
// mapbox-gl loads lazily so the fallback build never pays for it.
import { useEffect, useRef } from "react";
import { env } from "@/lib/env";
import { fitPointsToViewBox, toSvgPath } from "@/lib/map-fit";

export interface MapPoint {
  lat: number;
  lng: number;
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
            stroke="var(--sky-bright)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {start && <circle cx={start.x} cy={start.y} r={4} fill="var(--pine-400)" />}
          {head && (
            <circle
              cx={head.x}
              cy={head.y}
              r={5}
              fill="var(--teal-live)"
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

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (!container.current || mapRef.current) return;
      const mapboxgl = (await import("mapbox-gl")).default;
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
      const coords = points.map((p) => [p.lng, p.lat]);
      const data = {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "LineString" as const, coordinates: coords },
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
          paint: { "line-color": "#38BDF8", "line-width": 4 },
        });
      }
      const last = points[points.length - 1]!;
      if (live) map.easeTo({ center: [last.lng, last.lat] });
    };
    if (map.isStyleLoaded()) draw();
    else map.once("load", draw);
  }, [points, live]);

  return <div className="map-view" data-renderer="mapbox" ref={container} />;
}
