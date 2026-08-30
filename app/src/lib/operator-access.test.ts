// The subscription gate matrix (review H31). The failure direction that
// matters is the OPEN one: no unreadable input may ever read as "lapsed",
// because locking a paying operator out on bad data is the M39/qc(1–4)
// stranding class with money attached.
import { describe, expect, it } from "vitest";
import { operatorAccess } from "./operator-access";

const NOW = Date.parse("2026-08-30T12:00:00Z");
const FUTURE = "2026-09-10T12:00:00Z";
const PAST = "2026-08-01T12:00:00Z";

describe("operatorAccess", () => {
  it("a live subscription is full access, whatever the trial says", () => {
    expect(operatorAccess({ trialEndsAt: PAST, platformSubscriptionStatus: "active" }, NOW))
      .toBe("full");
    expect(operatorAccess({ trialEndsAt: FUTURE, platformSubscriptionStatus: "active" }, NOW))
      .toBe("full");
  });

  it("past_due is grace — a banner while Stripe duns, never a wall", () => {
    expect(operatorAccess({ trialEndsAt: PAST, platformSubscriptionStatus: "past_due" }, NOW))
      .toBe("grace");
  });

  it("inside the trial window everything short of a live subscription is still full", () => {
    for (const status of ["none", "cancelled", "paused"]) {
      expect(
        operatorAccess({ trialEndsAt: FUTURE, platformSubscriptionStatus: status }, NOW),
        `status ${status}`,
      ).toBe("full");
    }
  });

  it("trial over with no live subscription is locked", () => {
    for (const status of ["none", "cancelled", "paused"]) {
      expect(
        operatorAccess({ trialEndsAt: PAST, platformSubscriptionStatus: status }, NOW),
        `status ${status}`,
      ).toBe("locked");
    }
  });

  it("the boundary instant itself is locked (now >= trial end)", () => {
    expect(operatorAccess({ trialEndsAt: FUTURE, platformSubscriptionStatus: "none" },
      Date.parse(FUTURE))).toBe("locked");
  });

  it("fails OPEN on anything unreadable", () => {
    // Missing state entirely.
    expect(operatorAccess(null, NOW)).toBe("full");
    // An unparseable trial date must not lock anyone out.
    expect(operatorAccess({ trialEndsAt: "garbage", platformSubscriptionStatus: "none" }, NOW))
      .toBe("full");
    // A status value this code has never seen decides nothing.
    expect(operatorAccess({ trialEndsAt: PAST, platformSubscriptionStatus: "brand_new" }, NOW))
      .toBe("full");
  });

  it("a null trial with no live subscription is locked, not open", () => {
    // NOT NULL in the schema — a null here is a fixture or a stale cache,
    // and the STATUS is still readable: 'none' past any conceivable trial.
    expect(operatorAccess({ trialEndsAt: null, platformSubscriptionStatus: "none" }, NOW))
      .toBe("locked");
  });
});
