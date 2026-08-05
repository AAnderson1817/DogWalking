import { describe, expect, it } from "vitest";
import {
  clientStatusTreatment,
  paymentStatusTreatment,
  subscriptionStatusTreatment,
  walkStatusTreatment,
} from "./status-treatment";

describe("status treatment mappings", () => {
  it("maps walk states and overage without relying on color-only meaning", () => {
    expect(walkStatusTreatment("scheduled")).toEqual({
      badge: "scheduled",
      label: "Scheduled",
    });
    expect(walkStatusTreatment("in_progress")).toEqual({
      badge: "in_progress",
      label: "In progress",
    });
    expect(walkStatusTreatment("completed")).toEqual({
      badge: "completed",
      label: "Complete",
    });
    expect(walkStatusTreatment("cancelled")).toEqual({
      badge: "cancelled",
      label: "Cancelled",
    });
    expect(walkStatusTreatment("no_show")).toEqual({
      badge: "no_show",
      label: "No-show",
    });
    expect(walkStatusTreatment("completed", true)).toEqual({
      badge: "overage",
      label: "Overage",
    });
  });

  it("keeps inactive clients muted rather than presenting them as warnings", () => {
    expect(clientStatusTreatment("invited")).toEqual({
      badge: "scheduled",
      label: "Invited",
    });
    expect(clientStatusTreatment("active")).toEqual({
      badge: "completed",
      label: "Active",
    });
    expect(clientStatusTreatment("paused").badge).toBe("cancelled");
    expect(clientStatusTreatment("archived").badge).toBe("cancelled");
  });

  it("distinguishes attention from inactive subscription states", () => {
    expect(subscriptionStatusTreatment("past_due")).toEqual({
      badge: "attention",
      label: "Past due",
    });
    expect(subscriptionStatusTreatment("paused").badge).toBe("cancelled");
    expect(subscriptionStatusTreatment("cancelled").badge).toBe("cancelled");
    expect(subscriptionStatusTreatment("none").badge).toBe("neutral");
  });

  it("uses explicit human labels for every payment state", () => {
    expect(paymentStatusTreatment("pending")).toEqual({
      badge: "scheduled",
      label: "Processing",
    });
    expect(paymentStatusTreatment("succeeded")).toEqual({
      badge: "completed",
      label: "Collected",
    });
    expect(paymentStatusTreatment("failed")).toEqual({
      badge: "attention",
      label: "Needs attention",
    });
    expect(paymentStatusTreatment("refunded")).toEqual({
      badge: "cancelled",
      label: "Refunded",
    });
  });
});
