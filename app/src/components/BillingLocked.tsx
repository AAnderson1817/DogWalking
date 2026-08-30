// The subscription wall (review H31): what an operator sees when the 14-day
// trial is over and no live Sanpo subscription exists. Rendered IN PLACE by
// RequireRole — the LoadError precedent — so there is no route to guard and
// no redirect loop with SignIn's operator→"/" effect.
//
// Their DATA is not held hostage: this gates the app, and the 0045 migration
// deliberately changes no RLS. Signing out, subscribing, and reading the
// pricing page are the three things a locked operator needs.
import { useState } from "react";
import { Link } from "react-router-dom";
import { AppMain } from "./AppMain";
import { Button } from "./Button";
import { Card } from "./Card";
import { FormError } from "./fields";
import { createOperatorCheckout, createOperatorPortal } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { money } from "@/lib/format";
import { PLATFORM_PRICE_PENCE } from "@/lib/operator-access";

export function BillingLocked() {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The H32 persistent-link pattern: window.open with "noopener" returns
  // null even on success, so a blocked popup is indistinguishable from an
  // opened one — the rendered link is the reliable surface.
  const [payLink, setPayLink] = useState<string | null>(null);

  const cancelled = auth.operatorBilling?.platformSubscriptionStatus === "cancelled";

  async function subscribe() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await createOperatorCheckout();
      if (!url) throw new Error("checkout did not return a link");
      setPayLink(url);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : "checkout failed");
    } finally {
      setBusy(false);
    }
  }

  async function manageBilling() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await createOperatorPortal();
      setPayLink(url);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not open billing");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppMain>
      <div className="page page--centered">
        <Card>
          <h1 style={{ fontSize: "var(--fs-24)", marginTop: 0 }}>
            {cancelled ? "Your Sanpo subscription has ended" : "Your free trial has ended"}
          </h1>
          <p style={{ color: "var(--text-2)" }}>
            Sanpo is {money(PLATFORM_PRICE_PENCE)}/month. Your clients, walks,
            schedules and entry codes are all still here — subscribe to pick up where
            you left off.
          </p>
          <FormError message={error} />
          <Button full onClick={() => void subscribe()} disabled={busy}>
            {busy ? "Opening…" : "Subscribe"}
          </Button>
          {cancelled && (
            <Button variant="ghost" full onClick={() => void manageBilling()} disabled={busy}>
              Manage billing
            </Button>
          )}
          {payLink && (
            <>
              <p style={{ fontSize: "var(--fs-14)" }}>
                If nothing opened,{" "}
                <a href={payLink} target="_blank" rel="noreferrer">
                  use this link
                </a>
                . After paying, come back and check again.
              </p>
              <Button
                variant="ghost"
                full
                disabled={busy}
                onClick={() => {
                  // The webhook flips platform_subscription_status; the gate
                  // reads it through role resolution, so a refresh is the
                  // whole unlock.
                  void auth.refreshRole();
                }}
              >
                I've subscribed — check again
              </Button>
            </>
          )}
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
 * Rendered by RequireRole above the operator shell.
 */
export function BillingGraceBanner() {
  return (
    <div className="billing-grace" role="status">
      Your Sanpo subscription payment failed — update your card in{" "}
      <Link to="/settings">Settings</Link> to keep your subscription active.
    </div>
  );
}
