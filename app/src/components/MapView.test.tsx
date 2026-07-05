// MapView SVG fallback: renders a fitted polyline from fixture points
// without a Mapbox token (spec/phase 03 acceptance).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SvgMap } from "./MapView";
import { fitPointsToViewBox } from "@/lib/map-fit";

const FIXTURE = [
  { lat: 51.4419, lng: -0.0533 },
  { lat: 51.4423, lng: -0.0528 },
  { lat: 51.4427, lng: -0.0521 },
  { lat: 51.4425, lng: -0.0512 },
];

describe("MapView SVG fallback", () => {
  it("renders an svg path from fixture points", () => {
    const html = renderToStaticMarkup(<SvgMap points={FIXTURE} />);
    expect(html).toContain("<svg");
    expect(html).toContain('data-renderer="svg"');
    const d = /d="([^"]+)"/.exec(html)?.[1];
    expect(d).toBeTruthy();
    expect(d!.startsWith("M")).toBe(true);
    expect(d!.split("L").length).toBe(FIXTURE.length); // M + 3×L
  });

  it("shows the live head dot with pulse when live", () => {
    const html = renderToStaticMarkup(<SvgMap points={FIXTURE} live />);
    expect(html).toContain("pulse-live");
  });

  it("renders an empty state without points", () => {
    const html = renderToStaticMarkup(<SvgMap points={[]} />);
    expect(html).toContain("No route yet");
    expect(html).not.toContain("<svg");
  });
});

describe("fitPointsToViewBox", () => {
  it("keeps all points inside the padded box", () => {
    const fitted = fitPointsToViewBox(FIXTURE, { width: 320, height: 200, padding: 16 });
    for (const p of fitted) {
      expect(p.x).toBeGreaterThanOrEqual(16);
      expect(p.x).toBeLessThanOrEqual(304);
      expect(p.y).toBeGreaterThanOrEqual(16);
      expect(p.y).toBeLessThanOrEqual(184);
    }
  });

  it("north points up (larger lat ⇒ smaller y)", () => {
    const fitted = fitPointsToViewBox(
      [
        { lat: 51.44, lng: -0.05 },
        { lat: 51.45, lng: -0.05 },
      ],
    );
    expect(fitted[1]!.y).toBeLessThan(fitted[0]!.y);
  });

  it("handles a single point without NaN", () => {
    const fitted = fitPointsToViewBox([{ lat: 51.44, lng: -0.05 }]);
    expect(Number.isFinite(fitted[0]!.x)).toBe(true);
    expect(Number.isFinite(fitted[0]!.y)).toBe(true);
  });
});
