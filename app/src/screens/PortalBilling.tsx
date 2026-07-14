// PortalBilling (phase 07): plan card, read-only ledger, payments with
// receipt links, Stripe customer-portal launch for self-service.
import { useEffect, useState } from "react";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Spinner } from "@/components/Spinner";
import {
  billingPortal,
  getMyClient,
  getPlan,
  listLedger,
  listPayments,
} from "@/lib/api";
import { formatLedgerEntry } from "@/lib/credits";
import { dateLocal, money } from "@/lib/format";
import type { Clients, CreditLedger, Payments, Plans } from "@/lib/types";

export default function PortalBilling() {
  const [client, setClient] = useState<Clients | null>(null);
  const [plan, setPlan] = useState<Plans | null>(null);
  const [ledger, setLedger] = useState<CreditLedger[]>([]);
  const [payments, setPayments] = useState<Payments[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const me = await getMyClient();
      if (!me) throw new Error("We couldn't load your account. Please try again.");
      const [p, lg, pay] = await Promise.all([
        me.plan_id ? getPlan(me.plan_id) : Promise.resolve(null),
        listLedger(me.id),
        listPayments(me.id),
      ]);
      setClient(me);
      setPlan(p);
      setLedger(lg);
      setPayments(pay);
    }
    void load()
      .catch((e) => setLoadError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, []);

  if (loadError && !client) {
    return (
      <div className="page">
        <Card><EmptyState title="Couldn't load billing" hint={loadError} /></Card>
      </div>
    );
  }

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

  if (loading || !client) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  }

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
              <Badge status={client.subscription_status === "active" ? "completed" : "warn"}>
                {client.subscription_status}
              </Badge>
              {client.current_period_end && (
                <span style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
                  renews {dateLocal(client.current_period_end)}
                </span>
              )}
            </div>
          </div>
        ) : (
          <p style={{ color: "var(--text-2)", marginTop: "var(--s-2)" }}>
            No plan yet — your walker can set one up for you.
          </p>
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
          <p style={{ color: "var(--text-2)", marginTop: "var(--s-2)" }}>No credit activity yet.</p>
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

      <Card style={{ marginTop: "var(--s-3)" }}>
        <span className="section-label">Payments</span>
        {payments.length === 0 ? (
          <div style={{ marginTop: "var(--s-2)" }}>
            <EmptyState title="No payments yet" />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", marginTop: "var(--s-2)" }}>
            {payments.map((p) => (
              <div
                key={p.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "var(--s-2) 0",
                  borderBottom: "1px solid var(--mist)",
                  fontSize: "var(--fs-14)",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{p.type}</div>
                  <div style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>{dateLocal(p.created_at)}</div>
                </div>
                <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
                  <span className="numeral" style={{ fontWeight: 600 }}>{money(p.amount_pence)}</span>
                  <Badge status={p.status === "succeeded" ? "completed" : p.status === "failed" ? "warn" : "neutral"}>
                    {p.status}
                  </Badge>
                  {p.receipt_url && (
                    <a href={p.receipt_url} target="_blank" rel="noreferrer" style={{ color: "var(--pine-600)", fontSize: "var(--fs-12)" }}>
                      receipt
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
