import { useCallback, useEffect, useState } from "react";
import { Button } from "./Button";
import { FormError } from "./fields";
import { Spinner } from "./Spinner";
import { connectStart, connectStatus, type ConnectStatus } from "@/lib/api";

/**
 * Stripe Connect onboarding for the operator (review B5).
 *
 * Clients pay the operator directly — the operator is the merchant of record,
 * their business is on the card statement, and the money lands in their bank.
 * Until an account is connected AND Stripe has enabled charges, no subscription
 * can be created and no overage can be taken, so this states plainly what is
 * blocked rather than showing a neutral "not set up" chip.
 *
 * The three states are deliberately distinct. Collapsing "not connected" and
 * "Stripe is reviewing you" would send an operator who has already submitted
 * everything back through an onboarding flow they finished, and leave them
 * with no idea they simply have to wait.
 */
export function ConnectPanel() {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await connectStatus());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check your Stripe connection.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Stripe returns the operator here after onboarding, and account.updated
    // may land moments later. Re-checking on focus means the panel settles on
    // its own instead of stranding them on a stale "finish setup".
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  async function start() {
    setBusy(true);
    setError("");
    try {
      const { url } = await connectStart();
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open Stripe onboarding.");
      setBusy(false);
    }
  }

  if (loading) return null;
  if (status?.charges_enabled) return null; // nothing to say once it works

  const started = Boolean(status?.connected);
  const reviewing = started && status?.details_submitted && !status?.charges_enabled;

  return (
    <section className="connect-panel" aria-labelledby="connect-panel-heading">
      <h2 id="connect-panel-heading" className="connect-panel__title">
        {reviewing ? "Stripe is reviewing your details" : "Connect Stripe to get paid"}
      </h2>
      <p className="connect-panel__body">
        {reviewing
          ? "You have submitted everything Stripe asked for. Charges switch on once they finish "
            + "checking — usually minutes, sometimes a day. Nothing else is needed from you."
          : "Your clients pay you directly: your business appears on their card statement and the "
            + "money lands in your bank account. Until Stripe is connected, subscriptions and "
            + "overage charges cannot be taken."}
      </p>
      <FormError message={error} />
      {!reviewing && (
        <Button onClick={() => void start()} disabled={busy}>
          {busy ? <Spinner /> : started ? "Finish Stripe setup" : "Connect Stripe"}
        </Button>
      )}
    </section>
  );
}
