// PortalBilling (phase 07): plan card, read-only ledger, payments with
// receipt links, Stripe customer-portal launch for self-service.
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { LoadError, loadErrorMessage } from "@/components/LoadError";
import { PaymentRow } from "@/components/PaymentRow";
import { Spinner } from "@/components/Spinner";
import { LoadingState, StateField } from "@/components/StateField";
import { subscriptionStatusTreatment } from "@/components/status-treatment";
import {
  billingPortal,
  getMyClient,
  getPlan,
  listLedger,
  listPaymentsDetailed,
  type PaymentDetailed,
} from "@/lib/api";
import { formatLedgerEntry } from "@/lib/credits";
import { dateLocal, money } from "@/lib/format";
import type { Clients, CreditLedger, Plans } from "@/lib/types";

export default function PortalBilling() {
  const [client, setClient] = useState<Clients | null>(null);
  const [plan, setPlan] = useState<Plans | null>(null);
  const [ledger, setLedger] = useState<CreditLedger[]>([]);
  const [payments, setPayments] = useState<PaymentDetailed[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoadError(null);
    setLoading(true);
    return (async () => {
      const me = await getMyClient();
      if (!me) throw new Error("We couldn't load your account. Please try again.");
      const [p, lg, pay] = await Promise.all([
        me.plan_id ? getPlan(me.plan_id) : Promise.resolve(null),
        listLedger(me.id),
        listPaymentsDetailed(me.id),
      ]);
      setClient(me);
      setPlan(p);
      setLedger(lg);
      setPayments(pay);
    })()
      .catch((e) => setLoadError(loadErrorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openPortal() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await billingPortal(client?.id ?? "");
      window.open(url, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not open the billing portal");
    } finally {
      setBusy(false);
    }
  }

  if (loadError && !client) {
    return <LoadError title="Couldn't load billing" message={loadError} onRetry={reload} />;
  }
  if (loading || !client) {
    return (
      <div className="page">
        <LoadingState label="Loading billing" />
      </div>
    );
  }
  const subscriptionTreatment = subscriptionStatusTreatment(client.subscription_status);

  return (
    <div className="page">
      <h1>Billing</h1>

      <Card style={{ marginTop: "var(--s-4)" }}>
        <span className="section-label">Plan</span>
        {plan ? (
          <div style={{ marginTop: "var(--s-2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontWeight: 600 }}>{plan.name}</span>
              <span className="numeral" style={{ fontWeight: 600 }}>{money(plan.price_pence)}/{plan.cycle}</span>
            </div>
            <div style={{ color: "var(--text-2)", fontSize: "var(--fs-14)", marginTop: "var(--s-1)" }}>
              {plan.credits_per_cycle} credits per cycle · extra walks {money(plan.overage_rate_pence)}
            </div>
            <div style={{ marginTop: "var(--s-2)", display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
              <Badge status={subscriptionTreatment.badge}>
                {subscriptionTreatment.label}
              </Badge>
              {client.current_period_end && (
                <span style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
                  renews {dateLocal(client.current_period_end)}
                </span>
              )}
            </div>
          </div>
        ) : (
          <StateField compact title="No plan yet" detail="Your walker can set one up for you." />
        )}
        <div style={{ marginTop: "var(--s-3)" }}>
          <Button variant="ghost" full onClick={() => void openPortal()} disabled={busy}>
            {busy ? <Spinner /> : "Manage payment method, pause or cancel"}
          </Button>
          {error && <span className="field__error">{error}</span>}
        </div>
      </Card>

      <Card style={{ marginTop: "var(--s-3)" }}>
        <span className="section-label">Credit history</span>
        {ledger.length === 0 ? (
          <StateField compact title="No credit activity yet" />
        ) : (
          <table style={{ width: "100%", marginTop: "var(--s-2)", borderCollapse: "collapse", fontSize: "var(--fs-14)" }}>
            <tbody>
              {ledger.map((entry) => {
                const line = formatLedgerEntry(entry);
                return (
                  <tr key={entry.id} style={{ borderBottom: "1px solid var(--mist)" }}>
                    <td style={{ padding: "var(--s-2) 0" }}>
                      <div style={{ fontWeight: 600 }}>{line.label}</div>
                      <div style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>{dateLocal(line.createdAt)}</div>
                    </td>
                    <td className="numeral" style={{ textAlign: "right", fontWeight: 600 }}>{line.amount}</td>
                    <td className="numeral" style={{ textAlign: "right", color: "var(--text-2)", paddingLeft: "var(--s-3)" }}>
                      {line.balanceAfter}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <section style={{ marginTop: "var(--s-6)" }}>
        <span className="section-label">Payments</span>
        {payments.length === 0 ? (
          <Card style={{ marginTop: "var(--s-2)" }}>
            <EmptyState title="No payments yet" />
          </Card>
        ) : (
          <div className="payment-ledger">
            {payments.map((payment) => (
              <PaymentRow key={payment.id} payment={payment} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
