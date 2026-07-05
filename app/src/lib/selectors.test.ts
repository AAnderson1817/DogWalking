// Dashboard selectors (phase 05 acceptance): today filter + low-credit
// filter against fixtures.
import { describe, expect, it } from "vitest";
import {
  failedPayments,
  liveWalk,
  lowCreditClients,
  todayLondon,
  todaysWalks,
  unreadCount,
} from "./selectors";

const TODAY = "2026-07-06";

const walks = [
  { id: "w1", scheduled_date: TODAY, window_start: "14:00:00", status: "scheduled" },
  { id: "w2", scheduled_date: TODAY, window_start: "09:00:00", status: "scheduled" },
  { id: "w3", scheduled_date: "2026-07-07", window_start: "10:00:00", status: "scheduled" },
  { id: "w4", scheduled_date: TODAY, window_start: "08:00:00", status: "cancelled" },
  { id: "w5", scheduled_date: TODAY, window_start: "11:00:00", status: "in_progress" },
];

describe("todaysWalks", () => {
  it("filters to today and orders by window_start, cancelled last", () => {
    const result = todaysWalks(walks, TODAY);
    expect(result.map((w) => w.id)).toEqual(["w2", "w5", "w1", "w4"]);
  });
});

describe("liveWalk", () => {
  it("returns the most recently started in-progress walk", () => {
    const result = liveWalk([
      { status: "in_progress", started_at: "2026-07-06T09:00:00Z" },
      { status: "in_progress", started_at: "2026-07-06T11:00:00Z" },
      { status: "completed", started_at: "2026-07-06T12:00:00Z" },
    ]);
    expect(result?.started_at).toBe("2026-07-06T11:00:00Z");
  });
  it("returns null when nothing is live", () => {
    expect(liveWalk([{ status: "scheduled", started_at: null }])).toBeNull();
  });
});

describe("lowCreditClients", () => {
  const clients = [
    { id: "a", credit_balance: 0, status: "active", subscription_status: "active" },
    { id: "b", credit_balance: 2, status: "active", subscription_status: "active" },
    { id: "c", credit_balance: 3, status: "active", subscription_status: "active" },
    { id: "d", credit_balance: 1, status: "archived", subscription_status: "active" },
    { id: "e", credit_balance: 0, status: "active", subscription_status: "none" },
    { id: "f", credit_balance: 1, status: "active", subscription_status: "past_due" },
  ];

  it("keeps balance ≤ threshold, drops archived/unsubscribed, sorts by balance", () => {
    const result = lowCreditClients(clients, 2);
    expect(result.map((c) => c.id)).toEqual(["a", "f", "b"]);
  });
});

describe("failedPayments / unreadCount", () => {
  it("filters failed newest-first", () => {
    const result = failedPayments([
      { status: "failed", created_at: "2026-07-01T10:00:00Z" },
      { status: "succeeded", created_at: "2026-07-02T10:00:00Z" },
      { status: "failed", created_at: "2026-07-03T10:00:00Z" },
    ]);
    expect(result.map((p) => p.created_at)).toEqual([
      "2026-07-03T10:00:00Z",
      "2026-07-01T10:00:00Z",
    ]);
  });
  it("counts unread", () => {
    expect(unreadCount([{ read_at: null }, { read_at: "2026-07-01T10:00:00Z" }, { read_at: null }])).toBe(2);
  });
});

describe("todayLondon", () => {
  it("uses the London calendar day (BST midnight boundary)", () => {
    // 23:30 UTC on 15 Jul is 00:30 on 16 Jul in London (BST).
    expect(todayLondon(Date.parse("2026-07-15T23:30:00Z"))).toBe("2026-07-16");
    // Winter: UTC == London.
    expect(todayLondon(Date.parse("2026-01-15T23:30:00Z"))).toBe("2026-01-15");
  });
});
