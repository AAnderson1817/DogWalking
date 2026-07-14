import { describe, expect, it } from "vitest";
import { dateLocal, distanceKm, elapsed, money, time12, timeLocal, walkTime } from "./format";

describe("money", () => {
  it("formats cents as dollars", () => {
    expect(money(12345)).toBe("$123.45");
  });
  it("pads sub-dollar amounts", () => {
    expect(money(5)).toBe("$0.05");
    expect(money(100)).toBe("$1.00");
  });
  it("handles zero and negatives", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(-2200)).toBe("-$22.00");
  });
  it("groups thousands", () => {
    expect(money(123456789)).toBe("$1,234,567.89");
  });
});

describe("US Central rendering across CST/CDT", () => {
  it("renders winter (CST, UTC-6) timestamps at Central wall clock", () => {
    expect(timeLocal("2026-01-15T12:00:00Z")).toBe("6:00 AM");
    // 23:30 UTC is 17:30 CST — same calendar day.
    expect(dateLocal("2026-01-15T23:30:00Z")).toBe("Jan 15, 2026");
  });
  it("renders summer (CDT, UTC-5) timestamps shifted -5h", () => {
    expect(timeLocal("2026-07-15T12:00:00Z")).toBe("7:00 AM");
    // 03:30 UTC is the previous evening in Central.
    expect(dateLocal("2026-07-16T03:30:00Z")).toBe("Jul 15, 2026");
  });
  it("handles the spring-forward boundary", () => {
    // CDT began 2026-03-08 08:00 UTC (2:00 AM local skips to 3:00 AM).
    expect(timeLocal("2026-03-08T07:59:00Z")).toBe("1:59 AM");
    expect(timeLocal("2026-03-08T08:00:00Z")).toBe("3:00 AM");
  });
});

describe("time12", () => {
  it("converts wall-clock walk windows to 12-hour", () => {
    expect(time12("00:30:00")).toBe("12:30 AM");
    expect(time12("12:00:00")).toBe("12:00 PM");
    expect(time12("13:05:00")).toBe("1:05 PM");
    expect(time12("23:45:00")).toBe("11:45 PM");
  });
});

describe("walkTime", () => {
  it("labels the slot with US weekday + 12-hour window", () => {
    expect(walkTime("2026-07-06", "12:00:00", "13:00:00")).toBe("Mon, Jul 6, 12:00 PM–1:00 PM");
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
