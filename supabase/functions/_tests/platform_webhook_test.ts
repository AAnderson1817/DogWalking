// platform-webhook: PLATFORM-account events → operators.platform_* state
// (review H31). The endpoint is stripe-webhook's mirror image, and so are
// the failure modes pinned here: a Connect event reaching this endpoint is
// ignored before any effect, a dunning redelivery rings no second bell, and
// an unfinished checkout never downgrades a live subscription.
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import {
  assertFilterSafeId,
  guardAdmits,
  handlePlatformEvent,
  InFlightError,
  mapPlatformSubscriptionStatus,
  type OperatorBillingRef,
  type OperatorWriteGuard,
  type PlatformEventLike,
  type PlatformWebhookDeps,
} from "../platform-webhook/handler.ts";

const OP_ID = "00000000-0000-4000-a000-0000000000aa";

interface Recorded {
  call: string;
  args: unknown[];
}

function makeDeps(opts: {
  claim?: "fresh" | "duplicate" | "in_flight";
  opById?: OperatorBillingRef | null;
  opBySub?: OperatorBillingRef | null;
  opByCustomer?: OperatorBillingRef | null;
  updateCount?: number;
} = {}): { deps: PlatformWebhookDeps; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    recorded,
    deps: {
      claimEvent(id, type, payload) {
        recorded.push({ call: "claimEvent", args: [id, type, payload] });
        return Promise.resolve(opts.claim ?? "fresh");
      },
      markProcessed(id) {
        recorded.push({ call: "markProcessed", args: [id] });
        return Promise.resolve();
      },
      findOperatorById(id) {
        recorded.push({ call: "findOperatorById", args: [id] });
        return Promise.resolve(opts.opById ?? null);
      },
      findOperatorBySubscription(subId) {
        recorded.push({ call: "findOperatorBySubscription", args: [subId] });
        return Promise.resolve(opts.opBySub ?? null);
      },
      findOperatorByCustomer(customerId) {
        recorded.push({ call: "findOperatorByCustomer", args: [customerId] });
        return Promise.resolve(opts.opByCustomer ?? null);
      },
      updateOperator(id, fields, unlessStatus) {
        recorded.push({ call: "updateOperator", args: [id, fields, unlessStatus] });
        return Promise.resolve(opts.updateCount ?? 1);
      },
      insertNotification(row) {
        recorded.push({ call: "insertNotification", args: [row] });
        return Promise.resolve();
      },
    },
  };
}

/**
 * A STATEFUL double: one operator row that updateOperator actually mutates,
 * honoring unlessStatus, with the finders reading it. The adversarial review
 * broke the first version of this handler with event SEQUENCES (dunning
 * exhaustion delivers payment_failed and deleted in either order), and every
 * canned-return test was blind to that by construction — a sequence needs
 * state that evolves.
 */
function makeStatefulDeps(row: {
  id: string;
  customer: string;
  platform_subscription_id: string | null;
  platform_subscription_status: string;
}, opts: {
  /** Fires ONCE, after the first find resolves — the seam where a
   * concurrent event's write lands between this arm's read and its write.
   * The TOCTOU races Codex found on PR #77 live exactly there. */
  afterFirstFind?: (row: {
    platform_subscription_id: string | null;
    platform_subscription_status: string;
  }) => void;
} = {}): { deps: PlatformWebhookDeps; row: typeof row; bells: Array<Record<string, unknown>> } {
  const bells: Array<Record<string, unknown>> = [];
  let findSeen = false;
  const raced = <T>(v: T): T => {
    if (!findSeen) {
      findSeen = true;
      opts.afterFirstFind?.(row);
    }
    return v;
  };
  const ref = (): OperatorBillingRef => ({
    id: row.id,
    platform_subscription_id: row.platform_subscription_id,
    platform_subscription_status: row.platform_subscription_status,
  });
  return {
    row,
    bells,
    deps: {
      claimEvent: () => Promise.resolve("fresh"),
      markProcessed: () => Promise.resolve(),
      // Each finder computes its answer from the row BEFORE raced() fires the
      // hook — the returned ref is the stale read, and the hook is the
      // concurrent write landing just after it.
      findOperatorById: (id) => Promise.resolve(raced(id === row.id ? ref() : null)),
      findOperatorBySubscription: (subId) =>
        Promise.resolve(raced(row.platform_subscription_id === subId ? ref() : null)),
      findOperatorByCustomer: (customerId) =>
        Promise.resolve(raced(row.customer === customerId ? ref() : null)),
      updateOperator(id, fields, guard) {
        if (id !== row.id) return Promise.resolve(0);
        // The double evaluates guardAdmits — the exported specification the
        // real PostgREST translation is pinned against — at write time,
        // against the row as it stands NOW, which is what makes the raced
        // tests mean something: a stale read cannot satisfy a guard the row
        // no longer admits.
        if (!guardAdmits(guard, row)) return Promise.resolve(0);
        if ("platform_subscription_id" in fields) {
          row.platform_subscription_id = fields.platform_subscription_id as string;
        }
        if ("platform_subscription_status" in fields) {
          row.platform_subscription_status = fields.platform_subscription_status as string;
        }
        return Promise.resolve(1);
      },
      insertNotification(r) {
        bells.push(r);
        return Promise.resolve();
      },
    },
  };
}

const LIVE_OP: OperatorBillingRef = {
  id: OP_ID,
  platform_subscription_id: "sub_1",
  platform_subscription_status: "active",
};

function event(
  type: string,
  object: Record<string, unknown>,
  over: Partial<PlatformEventLike> = {},
): PlatformEventLike {
  return { id: "evt_1", type, data: { object }, ...over };
}

Deno.test("a Connect event (account set) is ignored before ANY effect — even the claim", async () => {
  const { deps, recorded } = makeDeps();
  const res = await handlePlatformEvent(
    event("customer.subscription.updated", { id: "sub_1", status: "active" }, {
      account: "acct_123",
    }),
    deps,
  );
  assertEquals(res.status, "ignored");
  assertEquals(recorded.length, 0, "a Connect event drove effects on the platform endpoint");
});

Deno.test("duplicate claim acks with no effects; in-flight throws so Stripe retries", async () => {
  const dup = makeDeps({ claim: "duplicate" });
  const res = await handlePlatformEvent(
    event("customer.subscription.updated", { id: "sub_1", status: "active" }),
    dup.deps,
  );
  assertEquals(res.status, "duplicate");
  assert(!dup.recorded.some((r) => r.call === "updateOperator"));

  const inflight = makeDeps({ claim: "in_flight" });
  const err = await assertRejects(() =>
    handlePlatformEvent(
      event("customer.subscription.updated", { id: "sub_1", status: "active" }),
      inflight.deps,
    )
  );
  assert(err instanceof InFlightError, `got ${String(err)}`);
});

const UNBOUND_OP: OperatorBillingRef = {
  id: OP_ID,
  platform_subscription_id: null,
  platform_subscription_status: "none",
};

Deno.test("checkout.session.completed (paid) binds the subscription and activates", async () => {
  const { deps, recorded } = makeDeps({ opById: UNBOUND_OP });
  const res = await handlePlatformEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      subscription: "sub_new",
      payment_status: "paid",
      metadata: { operator_id: OP_ID },
    }),
    deps,
  );
  assertEquals(res.status, "processed");
  const upd = recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[0], OP_ID);
  assertEquals(upd?.args[1], {
    platform_subscription_id: "sub_new",
    platform_subscription_status: "active",
  });
});

Deno.test("a trial's first session is no_payment_required and still activates", async () => {
  const { deps, recorded } = makeDeps({ opById: UNBOUND_OP });
  await handlePlatformEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      subscription: "sub_new",
      payment_status: "no_payment_required",
      metadata: { operator_id: OP_ID },
    }),
    deps,
  );
  const upd = recorded.find((r) => r.call === "updateOperator");
  assertEquals(
    (upd?.args[1] as Record<string, unknown>).platform_subscription_status,
    "active",
  );
});

Deno.test("an UNPAID completed session binds the id but grants no status — the H32 lesson", async () => {
  const { deps, recorded } = makeDeps({ opById: UNBOUND_OP });
  const res = await handlePlatformEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      subscription: "sub_new",
      payment_status: "unpaid",
      metadata: { operator_id: OP_ID },
    }),
    deps,
  );
  assertEquals(res.status, "processed");
  const upd = recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], { platform_subscription_id: "sub_new" });
});

Deno.test("completed sessions that are not ours are ignored", async () => {
  for (
    const object of [
      { mode: "payment", subscription: "sub_x", metadata: { operator_id: OP_ID } },
      { mode: "subscription", subscription: "sub_x", metadata: {} },
      { mode: "subscription", metadata: { operator_id: OP_ID } },
    ]
  ) {
    const { deps, recorded } = makeDeps();
    const res = await handlePlatformEvent(event("checkout.session.completed", object), deps);
    assertEquals(res.status, "ignored");
    assert(!recorded.some((r) => r.call === "updateOperator"));
  }
});

Deno.test("subscription status map: trialing is active, incomplete decides nothing", () => {
  assertEquals(mapPlatformSubscriptionStatus("trialing"), "active");
  assertEquals(mapPlatformSubscriptionStatus("active"), "active");
  assertEquals(mapPlatformSubscriptionStatus("past_due"), "past_due");
  assertEquals(mapPlatformSubscriptionStatus("unpaid"), "past_due");
  assertEquals(mapPlatformSubscriptionStatus("paused"), "paused");
  assertEquals(mapPlatformSubscriptionStatus("canceled"), "cancelled");
  assertEquals(mapPlatformSubscriptionStatus("incomplete_expired"), "cancelled");
  assertEquals(mapPlatformSubscriptionStatus("incomplete"), null);
  assertEquals(mapPlatformSubscriptionStatus("something_new"), null);
});

Deno.test("subscription.updated mirrors the mapped status onto the bound operator", async () => {
  const { deps, recorded } = makeDeps({ opBySub: LIVE_OP });
  await handlePlatformEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "past_due" }),
    deps,
  );
  const upd = recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], {
    platform_subscription_id: "sub_1",
    platform_subscription_status: "past_due",
  });
});

Deno.test("an incomplete subscription event never downgrades a live row", async () => {
  const { deps, recorded } = makeDeps({ opBySub: LIVE_OP });
  const res = await handlePlatformEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "incomplete" }),
    deps,
  );
  assertEquals(res.status, "ignored");
  assert(!recorded.some((r) => r.call === "updateOperator"));
});

Deno.test("subscription.created can beat the checkout event: bound through the customer, but only while unbound", async () => {
  // Unbound operator: the customer lookup binds it.
  const race = makeDeps({
    opBySub: null,
    opByCustomer: { id: OP_ID, platform_subscription_id: null, platform_subscription_status: "none" },
  });
  await handlePlatformEvent(
    event("customer.subscription.created", { id: "sub_new", customer: "cus_1", status: "trialing" }),
    race.deps,
  );
  const upd = race.recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], {
    platform_subscription_id: "sub_new",
    platform_subscription_status: "active",
  });

  // Already bound to a DIFFERENT subscription: some other subscription's
  // event must not clobber the bound one.
  const bound = makeDeps({
    opBySub: null,
    opByCustomer: { id: OP_ID, platform_subscription_id: "sub_existing", platform_subscription_status: "active" },
  });
  const res = await handlePlatformEvent(
    event("customer.subscription.created", { id: "sub_other", customer: "cus_1", status: "active" }),
    bound.deps,
  );
  assertEquals(res.status, "ignored");
  assert(!bound.recorded.some((r) => r.call === "updateOperator"));
});

Deno.test("subscription.deleted cancels and tells the operator — once", async () => {
  const first = makeDeps({ opBySub: LIVE_OP, updateCount: 1 });
  await handlePlatformEvent(
    event("customer.subscription.deleted", { id: "sub_1", status: "canceled" }),
    first.deps,
  );
  const upd = first.recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], { platform_subscription_status: "cancelled" });
  assertEquals(upd?.args[2], { whileBoundTo: "sub_1", unlessStatusIn: ["cancelled"] });
  const note = first.recorded.find((r) => r.call === "insertNotification");
  assert(note, "no cancellation notification");
  const row = note.args[0] as Record<string, unknown>;
  assertEquals(row.client_id, null);
  assertEquals(row.type, "subscription_cancelled");

  // Redelivery: the row is already cancelled, the gated update changes
  // nothing, and the bell must not ring again.
  const again = makeDeps({
    opBySub: { ...LIVE_OP, platform_subscription_status: "cancelled" },
    updateCount: 0,
  });
  await handlePlatformEvent(
    event("customer.subscription.deleted", { id: "sub_1", status: "canceled" }),
    again.deps,
  );
  assert(
    !again.recorded.some((r) => r.call === "insertNotification"),
    "a redelivered cancellation rang the bell twice",
  );
});

Deno.test("invoice.payment_failed marks past_due and notifies the OPERATOR — transition-gated", async () => {
  const first = makeDeps({ opBySub: LIVE_OP, updateCount: 1 });
  await handlePlatformEvent(
    event("invoice.payment_failed", { id: "in_1", subscription: "sub_1" }),
    first.deps,
  );
  const upd = first.recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], { platform_subscription_status: "past_due" });
  assertEquals(upd?.args[2], { whileBoundTo: "sub_1", unlessStatusIn: ["past_due", "cancelled"] });
  const note = first.recorded.find((r) => r.call === "insertNotification");
  assert(note, "no payment-failed notification");
  const row = note.args[0] as Record<string, unknown>;
  assertEquals(row.operator_id, OP_ID);
  assertEquals(row.client_id, null);
  assertEquals(row.type, "payment_failed");

  // Stripe redelivers payment_failed on every dunning retry with a FRESH
  // event id (the H13 lesson) — already past_due means no second bell.
  const retry = makeDeps({
    opBySub: { ...LIVE_OP, platform_subscription_status: "past_due" },
    updateCount: 0,
  });
  await handlePlatformEvent(
    event("invoice.payment_failed", { id: "in_2", subscription: "sub_1" }),
    retry.deps,
  );
  assert(
    !retry.recorded.some((r) => r.call === "insertNotification"),
    "a dunning retry rang the bell twice",
  );
});

Deno.test("events for nobody we know are ignored, and unknown types ack silently", async () => {
  const { deps } = makeDeps({ opBySub: null, opByCustomer: null });
  const res = await handlePlatformEvent(
    event("invoice.payment_failed", { id: "in_1", subscription: "sub_stranger" }),
    deps,
  );
  assertEquals(res.status, "ignored");

  const other = makeDeps();
  const res2 = await handlePlatformEvent(event("charge.succeeded", { id: "ch_1" }), other.deps);
  assertEquals(res2.status, "ignored");
});

Deno.test("index.ts reads its OWN secret, never the Connect endpoint's", async () => {
  // No seam exists for this: the secret is read inside Deno.serve, and a
  // wrong-secret wiring fails silently and completely (every signature
  // rejected, Stripe gives up after three days). The source is the contract.
  const src = await Deno.readTextFile(
    new URL("../platform-webhook/index.ts", import.meta.url),
  );
  assert(src.includes('Deno.env.get("STRIPE_PLATFORM_WEBHOOK_SECRET")'));
  assert(
    !src.includes('Deno.env.get("STRIPE_WEBHOOK_SECRET")'),
    "platform-webhook reads the Connect endpoint's secret",
  );
});

// ── The sequence rules the adversarial review broke the first version on ───

Deno.test("dunning exhaustion in EITHER order leaves the row cancelled — a dead subscription cannot resurrect", async () => {
  // Stripe emits the final invoice.payment_failed and subscription.deleted
  // moments apart with no ordering guarantee. deleted-first used to let the
  // late payment_failed flip cancelled → past_due, which is GRACE — free
  // access forever, with the honest resubscribe then refused.
  const s = makeStatefulDeps({
    id: OP_ID,
    customer: "cus_1",
    platform_subscription_id: "sub_1",
    platform_subscription_status: "past_due",
  });
  await handlePlatformEvent(
    event("customer.subscription.deleted", { id: "sub_1", status: "canceled" }),
    s.deps,
  );
  assertEquals(s.row.platform_subscription_status, "cancelled");
  const res = await handlePlatformEvent(
    event("invoice.payment_failed", { id: "in_9", subscription: "sub_1" }, { id: "evt_late" }),
    s.deps,
  );
  assertEquals(res.status, "ignored");
  assertEquals(s.row.platform_subscription_status, "cancelled");
  // Exactly one bell: the cancellation. No 'keep your subscription active'
  // for a subscription that no longer exists.
  assertEquals(s.bells.map((b) => b.type), ["subscription_cancelled"]);
});

Deno.test("a redelivered live event of the DEAD subscription id cannot resurrect it either", async () => {
  const s = makeStatefulDeps({
    id: OP_ID,
    customer: "cus_1",
    platform_subscription_id: "sub_1",
    platform_subscription_status: "cancelled",
  });
  const res = await handlePlatformEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "active" }),
    s.deps,
  );
  assertEquals(res.status, "ignored");
  assertEquals(s.row.platform_subscription_status, "cancelled");
});

Deno.test("a NEW subscription rebinds over a dead binding through the customer — resubscribe heals without checkout's event", async () => {
  // After cancellation the row keeps the old id as a tombstone; a
  // resubscribe whose checkout.session.completed is lost must still bind
  // via subscription.created/updated, or the operator pays monthly and
  // stays locked forever.
  const s = makeStatefulDeps({
    id: OP_ID,
    customer: "cus_1",
    platform_subscription_id: "sub_1",
    platform_subscription_status: "cancelled",
  });
  const res = await handlePlatformEvent(
    event("customer.subscription.created", { id: "sub_2", customer: "cus_1", status: "trialing" }),
    s.deps,
  );
  assertEquals(res.status, "processed");
  assertEquals(s.row.platform_subscription_id, "sub_2");
  assertEquals(s.row.platform_subscription_status, "active");
});

Deno.test("a second completed checkout NEVER clobbers a live binding — it rings the duplicate-subscription bell instead", async () => {
  const { deps, recorded } = makeDeps({ opById: LIVE_OP });
  const res = await handlePlatformEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      subscription: "sub_second",
      payment_status: "paid",
      metadata: { operator_id: OP_ID },
    }),
    deps,
  );
  assertEquals(res.status, "processed");
  assert(
    !recorded.some((r) => r.call === "updateOperator"),
    "a second subscription's completed event overwrote the live binding",
  );
  const note = recorded.find((r) => r.call === "insertNotification");
  assert(note, "the invisible duplicate subscription rang no bell");
  const row = note.args[0] as Record<string, unknown>;
  assertEquals(row.client_id, null);
  assert(String(row.title).toLowerCase().includes("second"));
});

Deno.test("a completed checkout MAY replace a dead binding — the resubscribe path", async () => {
  const { deps, recorded } = makeDeps({
    opById: { ...LIVE_OP, platform_subscription_status: "cancelled" },
  });
  await handlePlatformEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      subscription: "sub_2",
      payment_status: "paid",
      metadata: { operator_id: OP_ID },
    }),
    deps,
  );
  const upd = recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], {
    platform_subscription_id: "sub_2",
    platform_subscription_status: "active",
  });
});

Deno.test("invoice.payment_failed reads BOTH invoice shapes — Basil moved the subscription field", async () => {
  // The webhook payload shape follows the ENDPOINT's API version, not the
  // SDK pin, and Dashboard-created endpoints default to the account's
  // (post-Basil) version — reading only obj.subscription made this whole
  // arm dead code in every deployed environment.
  const { deps, recorded } = makeDeps({ opBySub: LIVE_OP, updateCount: 1 });
  const res = await handlePlatformEvent(
    event("invoice.payment_failed", {
      id: "in_1",
      parent: { subscription_details: { subscription: "sub_1" } },
    }),
    deps,
  );
  assertEquals(res.status, "processed");
  const upd = recorded.find((r) => r.call === "updateOperator");
  assertEquals(upd?.args[1], { platform_subscription_status: "past_due" });
  assert(recorded.some((r) => r.call === "insertNotification"));
});

// ── Atomic write guards (Codex review on PR #77): the TOCTOU races ─────────
//
// The sequence tests above run events one after another, so every read sees
// the previous write. Real deliveries OVERLAP: two edge invocations for two
// different event ids interleave freely, and a rule enforced by reading the
// row and deciding in memory evaporates in the gap before the write. These
// four pin that every rule the sequence tests establish still holds when the
// conflicting write lands INSIDE that gap — which is only true if the rule
// lives in the write's own predicate.

Deno.test("RACE: deleted landing between payment_failed's read and write cannot resurrect", async () => {
  const s = makeStatefulDeps({
    id: OP_ID,
    customer: "cus_1",
    platform_subscription_id: "sub_1",
    platform_subscription_status: "active",
  }, {
    // The concurrent deleted arm's write: terminal, after our read.
    afterFirstFind: (row) => {
      row.platform_subscription_status = "cancelled";
    },
  });
  await handlePlatformEvent(
    event("invoice.payment_failed", { id: "in_1", subscription: "sub_1" }),
    s.deps,
  );
  assertEquals(
    s.row.platform_subscription_status,
    "cancelled",
    "a raced payment_failed resurrected a cancelled row to grace",
  );
  assertEquals(s.bells.length, 0, "a dunning bell rang for a subscription that is already dead");
});

Deno.test("RACE: deleted landing between subscription.updated's read and write cannot resurrect", async () => {
  const s = makeStatefulDeps({
    id: OP_ID,
    customer: "cus_1",
    platform_subscription_id: "sub_1",
    platform_subscription_status: "active",
  }, {
    afterFirstFind: (row) => {
      row.platform_subscription_status = "cancelled";
    },
  });
  await handlePlatformEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "active" }),
    s.deps,
  );
  assertEquals(
    s.row.platform_subscription_status,
    "cancelled",
    "a raced subscription.updated resurrected a cancelled row to active",
  );
});

Deno.test("RACE: a LATE deleted for the OLD id cannot kill a rebind that won the gap", async () => {
  // deleted(sub_old) reads the row while it is still bound to sub_old; the
  // resubscribe's rebind then lands; the cancel must miss, because the
  // binding it belongs to is gone. Without pinning the write to its own
  // subscription id, the new $49/month subscription is marked cancelled and
  // the operator is locked out while paying.
  const s = makeStatefulDeps({
    id: OP_ID,
    customer: "cus_1",
    platform_subscription_id: "sub_old",
    platform_subscription_status: "cancelled",
  }, {
    afterFirstFind: (row) => {
      row.platform_subscription_id = "sub_new";
      row.platform_subscription_status = "active";
    },
  });
  // A redelivered deleted for the old subscription (fresh event id, so the
  // claim ledger does not dedupe it).
  await handlePlatformEvent(
    event("customer.subscription.deleted", { id: "sub_old", status: "canceled" }, { id: "evt_late_del" }),
    s.deps,
  );
  assertEquals(s.row.platform_subscription_id, "sub_new");
  assertEquals(
    s.row.platform_subscription_status,
    "active",
    "a late deleted for the old subscription cancelled the freshly rebound one",
  );
  assertEquals(s.bells.length, 0, "a cancellation bell rang against the live rebound subscription");
});

Deno.test("RACE: two completed checkouts — the loser's write is refused atomically and rings the duplicate bell", async () => {
  const s = makeStatefulDeps({
    id: OP_ID,
    customer: "cus_1",
    platform_subscription_id: null,
    platform_subscription_status: "none",
  }, {
    // The winning session's completed arm binds first, inside our gap.
    afterFirstFind: (row) => {
      row.platform_subscription_id = "sub_winner";
      row.platform_subscription_status = "active";
    },
  });
  await handlePlatformEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      subscription: "sub_loser",
      payment_status: "paid",
      metadata: { operator_id: OP_ID },
    }),
    s.deps,
  );
  assertEquals(
    s.row.platform_subscription_id,
    "sub_winner",
    "the losing session's write clobbered the winner's binding",
  );
  assertEquals(s.row.platform_subscription_status, "active");
  const titles = s.bells.map((b) => String(b.title).toLowerCase());
  assertEquals(titles.filter((t) => t.includes("second")).length, 1,
    "the raced duplicate subscription rang no bell — $49/month invisible");
});

Deno.test("guardAdmits truth table — the one specification both the double and the PostgREST translation answer to", () => {
  const row = (id: string | null, status: string) => ({
    platform_subscription_id: id,
    platform_subscription_status: status,
  });
  // No guard admits everything.
  assert(guardAdmits(undefined, row("sub_1", "cancelled")));

  // unlessStatusIn refuses exactly the listed statuses.
  const unless: OperatorWriteGuard = { unlessStatusIn: ["past_due", "cancelled"] };
  assert(!guardAdmits(unless, row("sub_1", "past_due")));
  assert(!guardAdmits(unless, row("sub_1", "cancelled")));
  assert(guardAdmits(unless, row("sub_1", "active")));

  // whileBoundTo: the write belongs to its binding and no other.
  const bound: OperatorWriteGuard = { whileBoundTo: "sub_1" };
  assert(guardAdmits(bound, row("sub_1", "active")));
  assert(!guardAdmits(bound, row("sub_2", "active")), "a replaced binding still accepted the old id's write");
  assert(!guardAdmits(bound, row(null, "none")));

  // bindableTo: null binds, dead-different rebinds, same-live re-writes;
  // live-different (duplicate) and same-dead (resurrection) refuse.
  const bind: OperatorWriteGuard = { bindableTo: "sub_new" };
  assert(guardAdmits(bind, row(null, "none")), "an unbound row refused its first binding");
  assert(guardAdmits(bind, row("sub_old", "cancelled")), "a tombstone refused a legitimate rebind");
  assert(guardAdmits(bind, row("sub_new", "active")), "an idempotent same-id re-write refused");
  assert(!guardAdmits(bind, row("sub_old", "active")), "a live binding admitted a rival subscription");
  assert(!guardAdmits(bind, row("sub_new", "cancelled")), "a dead same-id binding admitted its own resurrection");
});

Deno.test("assertFilterSafeId refuses anything that could smuggle PostgREST filter syntax", () => {
  assertFilterSafeId("sub_1AbC-x");
  for (const bad of ["sub,or", "a.b", "x(y)", "", "a b", 'q"t']) {
    let threw = false;
    try {
      assertFilterSafeId(bad);
    } catch {
      threw = true;
    }
    assert(threw, `accepted unsafe id ${JSON.stringify(bad)}`);
  }
});

Deno.test("index.ts translates the guard into the write's OWN predicate — the atomicity lives there", async () => {
  // No seam reaches makeDeps without a live PostgREST, so the source is the
  // contract, same as the secret pin above: the or-filter must express
  // exactly guardAdmits' bindableTo clause, and the loop/eq lines the other
  // two. A drift here is the double passing while the deploy races for real.
  const src = await Deno.readTextFile(
    new URL("../platform-webhook/index.ts", import.meta.url),
  );
  assert(
    src.includes('query = query.neq("platform_subscription_status", s)'),
    "unlessStatusIn no longer reaches the UPDATE predicate",
  );
  assert(
    src.includes('query = query.eq("platform_subscription_id", guard.whileBoundTo)'),
    "whileBoundTo no longer reaches the UPDATE predicate",
  );
  assert(
    src.includes('"platform_subscription_id.is.null,"') &&
      src.includes(
        "`and(platform_subscription_status.eq.cancelled,platform_subscription_id.neq.${guard.bindableTo}),`",
      ) &&
      src.includes(
        "`and(platform_subscription_id.eq.${guard.bindableTo},platform_subscription_status.neq.cancelled)`",
      ),
    "the bindableTo or-filter drifted from guardAdmits' three clauses",
  );
  assert(
    src.includes("assertFilterSafeId(guard.bindableTo)"),
    "the id reaches the filter string unvalidated",
  );
});

Deno.test("subscription.updated(past_due) and invoice.payment_failed ring ONE bell between them, whoever wins", async () => {
  // Stripe emits both for the same failed invoice in either order; the bell
  // lives on the status TRANSITION, so the loser of the race sees the row
  // already past_due and stays silent.
  const s = makeStatefulDeps({
    id: OP_ID,
    customer: "cus_1",
    platform_subscription_id: "sub_1",
    platform_subscription_status: "active",
  });
  await handlePlatformEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "past_due" }),
    s.deps,
  );
  assertEquals(s.bells.length, 1, "the updated arm must ring the dunning bell when it wins the race");
  await handlePlatformEvent(
    event("invoice.payment_failed", { id: "in_1", subscription: "sub_1" }, { id: "evt_2" }),
    s.deps,
  );
  assertEquals(s.bells.length, 1, "the race's loser rang a second bell");
  assertEquals(s.row.platform_subscription_status, "past_due");
});
