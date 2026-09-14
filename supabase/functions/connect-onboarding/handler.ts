// connect-onboarding flow (review B5), dependency-injected for tests.
//
// Creates and resumes the operator's Stripe Connect *Standard* account — a
// platform operation by definition. (The platform account also carries the
// operator's own Sanpo subscription since review H31, via operator-billing;
// everything CLIENT-facing stays on the connected account.)
//
// Standard, not Express or Custom, because the operator is the merchant of
// record: they own the Stripe account outright, their business is on the
// client's card statement, and they carry chargeback liability and Stripe's
// fees. Express and Custom put the platform in that position instead.
//
// The decisions live here behind a seam because `index.ts` binds a port on
// import and so nothing in it could be driven by a test — the blind spot
// that hid two defects in send-notification's deps and one in overage_deps.
// What connect_onboarding_test.ts pins: the order (account created, id
// claimed, link minted), the race loser adopting the winner's id, a failed
// claim minting NO link (the behavioural pin fix(send-lookups)'s re-read fix
// could only name), no call carrying `stripeAccount`, and the `action` rule.
import { HttpError } from "../_lib/http.ts";

export interface ConnectBody {
  /** 'start' mints an onboarding link; 'status' just reports where we are. */
  action?: "start" | "status";
}

export interface ConnectOperatorRow {
  id: string;
  email: string | null;
  business_name: string | null;
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
  stripe_details_submitted: boolean;
}

/** Stripe's per-request options, the SDK's real second parameter. Declared
 * so the platform-only rule is asserted at RUNTIME on a recorder rather than
 * made a type-level impossibility: a call that grows `{ stripeAccount }` must
 * go red in the test, not merely fail to compile under a cast. */
export interface StripeRequestOptions {
  stripeAccount?: string;
  idempotencyKey?: string;
}

/** The slice of the Stripe SDK this handler touches, parameter-typed so the
 * REAL client is assignable without a cast (a cast would hide exactly the
 * drift a type is for). The test passes a recorder that asserts no call ever
 * carries `stripeAccount` — a connected account and its onboarding link are
 * platform objects (review B5), and routing their creation to a connected
 * account is a category error. */
export interface PlatformConnectStripe {
  accounts: {
    create(
      params: {
        type: "standard";
        email?: string;
        business_profile: { name?: string };
        metadata: { operator_id: string };
      },
      opts?: StripeRequestOptions,
    ): Promise<{ id: string }>;
  };
  accountLinks: {
    create(
      params: {
        account: string;
        type: "account_onboarding";
        refresh_url: string;
        return_url: string;
      },
      opts?: StripeRequestOptions,
    ): Promise<{ url: string }>;
  };
}

export interface ConnectOnboardingDeps {
  /** The operator's row, or null when the caller is not an operator. Throws
   * HttpError(500, db_error) on a database failure — a failed lookup is not
   * an absence. */
  getOperator(id: string): Promise<ConnectOperatorRow | null>;
  /** Persist the Stripe account id iff the column is still null, then return
   * whatever the row now holds: the loser of a concurrent race adopts the
   * winner's account and its own becomes an inert orphan. Throws
   * HttpError(500, db_error) if either the write or the re-read fails — a
   * failed re-read is "we do not know which account is real", never "nobody
   * else claimed it", and the handler must mint NO link on it. */
  claimAccountId(operatorId: string, accountId: string): Promise<string>;
  stripe: PlatformConnectStripe;
  /** APP_BASE_URL. */
  base: string;
}

export interface ConnectStatus {
  connected: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
}

export interface ConnectStart {
  url: string;
  account_id: string;
}

export async function handleConnectOnboarding(
  operatorId: string,
  body: ConnectBody | null,
  deps: ConnectOnboardingDeps,
): Promise<ConnectStatus | ConnectStart> {
  const action = body?.action ?? "status";
  // Refused BEFORE any lookup, and the refusal is the behaviour change this
  // seam ships with: the shipped code tested only `=== "status"`, so any
  // other value — a typo, a stale client — fell through to `start` and
  // MINTED a Stripe Connect account. A typo creating an account is worse
  // than a 400; spec 04 names exactly two values and the frontend sends only
  // those.
  if (action !== "start" && action !== "status") {
    throw new HttpError(400, "bad_action", "action must be 'start' or 'status'");
  }

  const row = await deps.getOperator(operatorId);
  if (!row) throw new HttpError(403, "not_operator", "caller is not an operator");

  if (action === "status") {
    return {
      connected: Boolean(row.stripe_account_id),
      charges_enabled: row.stripe_charges_enabled,
      payouts_enabled: row.stripe_payouts_enabled,
      details_submitted: row.stripe_details_submitted,
    };
  }

  let accountId = row.stripe_account_id;
  if (!accountId) {
    const account = await deps.stripe.accounts.create({
      type: "standard",
      email: row.email ?? undefined,
      business_profile: { name: row.business_name ?? undefined },
      metadata: { operator_id: operatorId },
    });

    // Persisted BEFORE the AccountLink is minted. If this write failed after
    // the operator had already started onboarding, the next 'start' would
    // create a SECOND Stripe account, and the money would land in whichever
    // one Stripe happened to finish first — with the other left half-onboarded
    // and invisible. Losing the link is recoverable; losing the account id is
    // not. The claim answers with whichever id the row now carries: ours, or
    // a concurrent winner's, in which case ours is a harmless orphan — an
    // account with no onboarding and no charges is inert.
    accountId = await deps.claimAccountId(operatorId, account.id);
  }

  // AccountLinks are single-use and short-lived, so one is minted per attempt
  // rather than stored.
  const link = await deps.stripe.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: `${deps.base}/billing?connect=refresh`,
    return_url: `${deps.base}/billing?connect=return`,
  });

  return { url: link.url, account_id: accountId };
}
