import { describe, expect, it } from "vitest";
import {
  businessWallClockToMs,
  dateLocal,
  dayGreeting,
  distanceMi,
  elapsed,
  money,
  time12,
  timeLocal,
  timeRange12,
  walkDuration,
  walkTime,
} from "./format";

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

describe("timeRange12", () => {
  it("avoids repeating the same day period", () => {
    expect(timeRange12("15:00:00", "16:00:00")).toBe("3:00–4:00 PM");
  });

  it("keeps both day periods when the window crosses noon", () => {
    expect(timeRange12("11:30:00", "13:00:00")).toBe("11:30 AM–1:00 PM");
  });
});

describe("walkTime", () => {
  it("labels the slot with US weekday + 12-hour window", () => {
    expect(walkTime("2026-07-06", "12:00:00", "13:00:00")).toBe("Mon, Jul 6, 12:00 PM–1:00 PM");
  });
});

describe("walkDuration", () => {
  it("states the scheduled duration explicitly", () => {
    expect(walkDuration("09:00:00", "09:30:00")).toBe("30 min");
    expect(walkDuration("09:00:00", "10:00:00")).toBe("1 hr");
    expect(walkDuration("09:00:00", "10:30:00")).toBe("1 hr 30 min");
  });

  it("supports an overnight window", () => {
    expect(walkDuration("23:30:00", "00:15:00")).toBe("45 min");
  });
});

describe("dayGreeting", () => {
  it("uses the business timezone", () => {
    expect(dayGreeting("2026-07-15T13:00:00Z")).toBe("Good morning");
    expect(dayGreeting("2026-07-15T19:00:00Z")).toBe("Good afternoon");
    expect(dayGreeting("2026-07-16T01:00:00Z")).toBe("Good evening");
  });
});

describe("businessWallClockToMs", () => {
  it("interprets the wall clock in Central regardless of device tz", () => {
    // Summer (CDT, UTC-5): 09:00 Central on 2026-07-06 == 14:00 UTC.
    expect(businessWallClockToMs("2026-07-06", "09:00:00")).toBe(
      Date.parse("2026-07-06T14:00:00Z"),
    );
    // Winter (CST, UTC-6): 09:00 Central on 2026-01-06 == 15:00 UTC.
    expect(businessWallClockToMs("2026-01-06", "09:00:00")).toBe(
      Date.parse("2026-01-06T15:00:00Z"),
    );
  });
});

/**
 * Review M36. One formatter, in miles. Today used to convert inline and the
 * client's report used a metric one, so the same walk read "7.2 mi" on the
 * operator's home screen and "2.1 km" on the report the owner received.
 */
describe("distanceMi", () => {
  it("rounds to one decimal", () => {
    expect(distanceMi(1609.344)).toBe("1.0 mi");
    expect(distanceMi(2140)).toBe("1.3 mi");
    expect(distanceMi(640)).toBe("0.4 mi");
    expect(distanceMi(0)).toBe("0.0 mi");
  });
  it("dashes unset distances", () => {
    expect(distanceMi(null)).toBe("—");
    expect(distanceMi(undefined)).toBe("—");
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
