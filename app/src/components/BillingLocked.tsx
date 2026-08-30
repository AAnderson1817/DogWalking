// The subscription wall (review H31): what an operator sees when the 14-day
// trial is over and no live Sanpo subscription exists. Rendered IN PLACE by
// RequireRole — the LoadError precedent — so there is no route to guard and
// no redirect loop with SignIn's operator→"/" effect.
//
// Their DATA is not held hostage: this gates the app, and the 0045 migration
// deliberately changes no RLS. Subscribing, managing existing billing,
// re-checking, reading the pricing page, and signing out are the five things
// a locked operator needs — and the wall must cover every locked state,
// including the ones that CARRY a subscription (paused; bound-but-unpaid),
// where Subscribe is guaranteed to be refused and the portal is the answer
// (adversarial review).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppMain } from "./AppMain";
import { Button } from "./Button";
import { Card } from "./Card";
import { FormError } from "./fields";
import { createOperatorCheckout, createOperatorPortal, EdgeError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { money } from "@/lib/format";
import { PLATFORM_PRICE_PENCE } from "@/lib/operator-access";

export function BillingLocked() {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The H32 persistent-link pattern: window.open with "noopener" returns
  // null even on success, so a blocked popup is indistinguishable from an
  // opened one — the rendered link is the reliable surface.
  const [payLink, setPayLink] = useState<string | null>(null);

  const status = auth.operatorBilling?.platformSubscriptionStatus;
  const hasBilling = auth.operatorBilling?.hasBilling ?? false;

  // Billing state is fetched once per session with role resolution, so the
  // wall can be showing STALE data — an operator who subscribed in another
  // tab, or whose long-lived PWA session outlived a trial they already paid
  // past. The wall is exactly where stale data is catastrophic (a paying
  // customer locked out), so it refreshes on arrival; if the fresh answer
  // unlocks, RequireRole re-renders the app and this component unmounts.
  const { refreshRole } = auth;
  useEffect(() => {
    // refreshRole is a stable useCallback from the provider, so this runs
    // once per mount — and once is the point.
    void refreshRole();
  }, [refreshRole]);

  async function recheck() {
    setChecking(true);
    setError(null);
    try {
      await auth.refreshRole();
    } finally {
      setChecking(false);
    }
  }

  async function open(kind: "checkout" | "portal") {
    setBusy(true);
    setError(null);
    try {
      const { url } = kind === "checkout"
        ? await createOperatorCheckout()
        : await createOperatorPortal();
      if (!url) throw new Error("Stripe did not return a link");
      setPayLink(url);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      if (err instanceof EdgeError && err.code === "already_subscribed") {
        // The server sees a live subscription this screen's stale state does
        // not — which means the person has already paid. Refresh instead of
        // showing them a refusal for doing the right thing.
        setError("Your subscription is already active — rechecking your access…");
        await auth.refreshRole();
        return;
      }
      setError(err instanceof Error ? err.message : "Stripe could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  const heading = status === "cancelled"
    ? "Your Sanpo subscription has ended"
    : status === "paused"
    ? "Your Sanpo subscription is paused"
    : "Your free trial has ended";
  const body = status === "paused"
    ? "Resume it from Manage billing to keep using Sanpo — your clients, walks, schedules and entry codes are all still here."
    : `Sanpo is ${money(PLATFORM_PRICE_PENCE)}/month. Your clients, walks, schedules and entry codes are all still here — subscribe to pick up where you left off.`;

  return (
    <AppMain>
      <div className="page page--centered">
        <Card>
          <h1 style={{ fontSize: "var(--fs-24)", marginTop: 0 }}>{heading}</h1>
          <p style={{ color: "var(--text-2)" }}>{body}</p>
          <FormError message={error} />
          {status !== "paused" && (
            <Button full onClick={() => void open("checkout")} disabled={busy}>
              {busy ? "Opening…" : "Subscribe"}
            </Button>
          )}
          {hasBilling && (
            <Button variant="ghost" full onClick={() => void open("portal")} disabled={busy}>
              Manage billing
            </Button>
          )}
          {payLink && (
            <p style={{ fontSize: "var(--fs-14)" }}>
              If nothing opened,{" "}
              <a href={payLink} target="_blank" rel="noreferrer">
                use this link
              </a>
              . After paying, come back and check again.
            </p>
          )}
          <Button variant="ghost" full disabled={checking} onClick={() => void recheck()}>
            {checking ? "Checking…" : "I've subscribed — check again"}
          </Button>
          <p style={{ fontSize: "var(--fs-14)" }}>
            <Link to="/pricing">See what's included</Link>
          </p>
          <Button
            variant="ghost"
            full
            onClick={() => {
              void auth.signOut();
            }}
          >
            Sign out
          </Button>
        </Card>
      </div>
    </AppMain>
  );
}

/**
 * past_due is a banner, never a wall: Stripe is still dunning the card, and
 * locking the whole app over a hiccup punishes it as a cancellation.
 * Rendered by RequireRole above the operator shell — and deliberately NOT
 * above Walk Mode (deferLock), where a router link would be an unguarded
 * exit from an in-progress walk.
 */
export function BillingGraceBanner() {
  return (
    <div className="billing-grace" role="status">
      Your Sanpo subscription payment failed — update your card in{" "}
      <Link to="/settings">Settings</Link> to keep your subscription active.
    </div>
  );
}
