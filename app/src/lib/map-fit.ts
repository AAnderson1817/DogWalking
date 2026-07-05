// Auto-fit a lat/lng trail into an SVG viewBox (MapView fallback renderer).
// Pure — unit-tested directly.

export interface FitOptions {
  width?: number;
  height?: number;
  padding?: number;
}

export interface FittedPoint {
  x: number;
  y: number;
}

/**
 * Projects points with a simple equirectangular scale (fine at walk scale),
 * preserving aspect ratio and centering inside the box.
 */
export function fitPointsToViewBox(
  points: ReadonlyArray<{ lat: number; lng: number }>,
  { width = 320, height = 200, padding = 16 }: FitOptions = {},
): FittedPoint[] {
  if (points.length === 0) return [];
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;

  // Longitude degrees shrink with cos(latitude).
  const lngScale = Math.cos((midLat * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * lngScale, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);

  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const scale = Math.min(innerW / spanX, innerH / spanY);

  const usedW = spanX * scale;
  const usedH = spanY * scale;
  const offsetX = padding + (innerW - usedW) / 2;
  const offsetY = padding + (innerH - usedH) / 2;

  return points.map((p) => ({
    x: offsetX + ((p.lng - minLng) * lngScale) * scale,
    // SVG y grows downward; north is up.
    y: offsetY + (maxLat - p.lat) * scale,
  }));
}

export function toSvgPath(fitted: ReadonlyArray<FittedPoint>): string {
  if (fitted.length === 0) return "";
  return fitted
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
}
