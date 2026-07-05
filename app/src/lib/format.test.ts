import { describe, expect, it } from "vitest";
import { dateLondon, distanceKm, elapsed, gbp, timeLondon, walkTime } from "./format";

describe("gbp", () => {
  it("formats pence as pounds", () => {
    expect(gbp(12345)).toBe("£123.45");
  });
  it("pads sub-pound amounts", () => {
    expect(gbp(5)).toBe("£0.05");
    expect(gbp(100)).toBe("£1.00");
  });
  it("handles zero and negatives", () => {
    expect(gbp(0)).toBe("£0.00");
    expect(gbp(-2200)).toBe("-£22.00");
  });
  it("groups thousands", () => {
    expect(gbp(123456789)).toBe("£1,234,567.89");
  });
});

describe("London rendering across GMT/BST", () => {
  it("renders winter (GMT) timestamps at UTC wall clock", () => {
    // 2026-01-15 is GMT: UTC+0.
    expect(timeLondon("2026-01-15T12:00:00Z")).toBe("12:00");
    expect(dateLondon("2026-01-15T23:30:00Z")).toBe("15 Jan 2026");
  });
  it("renders summer (BST) timestamps shifted +1h", () => {
    // 2026-07-15 is BST: UTC+1.
    expect(timeLondon("2026-07-15T12:00:00Z")).toBe("13:00");
    // 23:30 UTC crosses midnight in London.
    expect(dateLondon("2026-07-15T23:30:00Z")).toBe("16 Jul 2026");
  });
  it("handles the spring-forward boundary", () => {
    // BST began 2026-03-29 01:00 UTC.
    expect(timeLondon("2026-03-29T00:59:00Z")).toBe("00:59");
    expect(timeLondon("2026-03-29T01:00:00Z")).toBe("02:00");
  });
});

describe("walkTime", () => {
  it("labels the slot with London weekday + window", () => {
    expect(walkTime("2026-07-06", "12:00:00", "13:00:00")).toBe("Mon 6 Jul, 12:00–13:00");
  });
});

describe("distanceKm", () => {
  it("rounds to one decimal", () => {
    expect(distanceKm(2140)).toBe("2.1 km");
    expect(distanceKm(640)).toBe("0.6 km");
    expect(distanceKm(0)).toBe("0.0 km");
  });
  it("dashes unset distances", () => {
    expect(distanceKm(null)).toBe("—");
    expect(distanceKm(undefined)).toBe("—");
  });
});

describe("elapsed", () => {
  const start = "2026-07-05T12:00:00Z";
  it("formats mm:ss under an hour", () => {
    expect(elapsed(start, Date.parse("2026-07-05T12:05:07Z"))).toBe("05:07");
  });
  it("formats h:mm:ss past the hour", () => {
    expect(elapsed(start, Date.parse("2026-07-05T13:02:03Z"))).toBe("1:02:03");
  });
  it("clamps negative drift to zero", () => {
    expect(elapsed(start, Date.parse("2026-07-05T11:59:59Z"))).toBe("00:00");
  });
});
