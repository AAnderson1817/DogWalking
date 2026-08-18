import type { BadgeStatus } from "./Badge";
import type {
  ClientStatus,
  PaymentStatus,
  SubscriptionStatus,
  WalkStatus,
} from "@/lib/types";

export interface StatusTreatment {
  badge: BadgeStatus;
  label: string;
}

const WALK_TREATMENTS: Record<WalkStatus, StatusTreatment> = {
  scheduled: { badge: "scheduled", label: "Scheduled" },
  in_progress: { badge: "in_progress", label: "In progress" },
  completed: { badge: "completed", label: "Complete" },
  cancelled: { badge: "cancelled", label: "Cancelled" },
  no_show: { badge: "no_show", label: "No-show" },
};

const CLIENT_TREATMENTS: Record<ClientStatus, StatusTreatment> = {
  invited: { badge: "scheduled", label: "Invited" },
  active: { badge: "completed", label: "Active" },
  paused: { badge: "cancelled", label: "Paused" },
  archived: { badge: "cancelled", label: "Archived" },
};

const SUBSCRIPTION_TREATMENTS: Record<SubscriptionStatus, StatusTreatment> = {
  none: { badge: "neutral", label: "No subscription" },
  active: { badge: "completed", label: "Active" },
  paused: { badge: "cancelled", label: "Paused" },
  past_due: { badge: "attention", label: "Past due" },
  cancelled: { badge: "cancelled", label: "Cancelled" },
};

const PAYMENT_TREATMENTS: Record<PaymentStatus, StatusTreatment> = {
  pending: { badge: "scheduled", label: "Processing" },
  succeeded: { badge: "completed", label: "Collected" },
  failed: { badge: "attention", label: "Needs attention" },
  refunded: { badge: "cancelled", label: "Refunded" },
  // A dispute is not a refund: the cardholder's bank pulled the money, it
  // carries a fee, and it can still be contested. It reads as attention
  // rather than cancelled because it is a thing the operator must act on.
  disputed: { badge: "attention", label: "Disputed" },
};

export function walkStatusTreatment(
  status: WalkStatus,
  isOverage = false,
): StatusTreatment {
  return isOverage
    ? { badge: "overage", label: "Overage" }
    : WALK_TREATMENTS[status];
}

export function clientStatusTreatment(status: ClientStatus): StatusTreatment {
  return CLIENT_TREATMENTS[status];
}

export function subscriptionStatusTreatment(
  status: SubscriptionStatus,
): StatusTreatment {
  return SUBSCRIPTION_TREATMENTS[status];
}

export function paymentStatusTreatment(
  status: PaymentStatus,
): StatusTreatment {
  return PAYMENT_TREATMENTS[status];
}
