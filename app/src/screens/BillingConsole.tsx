// Operator BillingConsole (phase 07): upcoming renewals (cached period
// ends), past_due dunning list, overage debts with re-charge, and plan
// changes through the change-plan edge fn.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Select } from "@/components/fields";
import { Sheet } from "@/components/Sheet";
import { Spinner } from "@/components/Spinner";
import {
  changePlan,
  chargeOverage,
  listClients,
  listPayments,
  listPlans,
} from "@/lib/api";
import { dateLocal, money } from "@/lib/format";
import type { Clients, Payments, Plans } from "@/lib/types";

export default function BillingConsole() {
  const [clients, setClients] = useState<Clients[] | null>(null);
  const [plans, setPlans] = useState<Plans[]>([]);
  const [payments, setPayments] = useState<Payments[]>([]);
  const [planChangeFor, setPlanChangeFor] = useState<Clients | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [cs, ps, pays] = await Promise.all([listClients(), listPlans(), listPayments()]);
    setClients(cs);
    setPlans(ps);
    setPayments(pays);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (clients === null) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  }

  const planName = (id: string | null) => plans.find((p) => p.id === id)?.name ?? "—";
  const clientName = (id: string) => clients.find((c) => c.id === id)?.full_name ?? "";

  const renewals = clients
    .filter((c) => c.subscription_status === "active")
    .sort((a, b) => (a.current_period_end ?? "9999").localeCompare(b.current_period_end ?? "9999"));
  const pastDue = clients.filter((c) => c.subscription_status === "past_due");
  const overageDebts = payments.filter((p) => p.type === "overage" && p.status === "failed");

  async function recharge(payment: Payments) {
    if (!payment.walk_id) return;
    setBusyId(payment.id);
    setNotice(null);
    try {
      const { payment: result } = await chargeOverage(payment.walk_id);
      setNotice(
        result.status === "succeeded"
          ? `Recovered ${money(result.amount_pence)} from ${clientName(payment.client_id)}.`
          : `Charge attempt is ${result.status}.`,
      );
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "re-charge failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <h1>Billing</h1>
      {notice && (
        <p style={{ marginTop: "var(--s-2)", color: "var(--text-2)", fontSize: "var(--fs-14)" }}>{notice}</p>
      )}

      <section style={{ marginTop: "var(--s-4)" }}>
        <span className="section-label">Upcoming renewals</span>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
          {renewals.length === 0 ? (
            <Card><EmptyState title="No active subscriptions" /></Card>
          ) : (
            renewals.map((c) => (
              <Card key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s-2)" }}>
                <div>
                  <Link to={`/clients/${c.id}`} style={{ fontWeight: 600, color: "var(--text)", textDecoration: "none" }}>
                    {c.full_name}
                  </Link>
                  <div style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
                    {planName(c.plan_id)}
                    {c.current_period_end ? ` · renews ${dateLocal(c.current_period_end)}` : " · renewal date syncs from Stripe"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
                  <span className="numeral" style={{ fontWeight: 700 }}>{c.credit_balance}</span>
                  <Button variant="ghost" onClick={() => setPlanChangeFor(c)}>Change plan</Button>
                </div>
              </Card>
            ))
          )}
        </div>
      </section>

      <section style={{ marginTop: "var(--s-6)" }}>
        <span className="section-label">Past due</span>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
          {pastDue.length === 0 ? (
            <Card><EmptyState title="Nobody past due" hint="Stripe retries failed renewals automatically." /></Card>
          ) : (
            pastDue.map((c) => (
              <Card key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <Link to={`/clients/${c.id}`} style={{ fontWeight: 600, color: "var(--text)", textDecoration: "none" }}>
                    {c.full_name}
                  </Link>
                  <div style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
                    {planName(c.plan_id)} · Stripe smart retries in progress
                  </div>
                </div>
                <Badge status="warn">past due</Badge>
              </Card>
            ))
          )}
        </div>
      </section>

      <section style={{ marginTop: "var(--s-6)" }}>
        <span className="section-label">Overage debts</span>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
          {overageDebts.length === 0 ? (
            <Card><EmptyState title="No outstanding walk charges" /></Card>
          ) : (
            overageDebts.map((p) => (
              <Card key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontWeight: 600 }}>{clientName(p.client_id)}</span>
                  <div style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
                    walk overage · {dateLocal(p.created_at)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
                  <span className="numeral" style={{ fontWeight: 600 }}>{money(p.amount_pence)}</span>
                  <Button
                    variant="accent"
                    onClick={() => void recharge(p)}
                    disabled={busyId === p.id || !p.walk_id}
                  >
                    {busyId === p.id ? <Spinner /> : "Re-charge"}
                  </Button>
                </div>
              </Card>
            ))
          )}
        </div>
      </section>

      {planChangeFor && (
        <PlanChangeSheet
          client={planChangeFor}
          plans={plans}
          onClose={() => setPlanChangeFor(null)}
          onChanged={(msg) => {
            setPlanChangeFor(null);
            setNotice(msg);
            void load();
          }}
        />
      )}
    </div>
  );
}

function PlanChangeSheet({
  client,
  plans,
  onClose,
  onChanged,
}: {
  client: Clients;
  plans: Plans[];
  onClose: () => void;
  onChanged: (msg: string) => void;
}) {
  const options = plans.filter((p) => p.active && p.id !== client.plan_id);
  const [planId, setPlanId] = useState(options[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!planId) return;
    setBusy(true);
    setError(null);
    try {
      const { new_balance } = await changePlan(client.id, planId);
      onChanged(`Plan changed — ${client.full_name} now holds ${new_balance} credits (upgrades prorate, downgrades never claw back).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "plan change failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={`Change plan — ${client.full_name}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <Select label="New plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {money(p.price_pence)}/{p.cycle}, {p.credits_per_cycle} credits
            </option>
          ))}
        </Select>
        <p style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
          Stripe prorates the price; credits prorate by the remaining cycle
          fraction on upgrades and are never clawed back on downgrades.
        </p>
        {error && <span className="field__error">{error}</span>}
        <Button full onClick={() => void submit()} disabled={busy || !planId}>
          {busy ? <Spinner /> : "Change plan"}
        </Button>
      </div>
    </Sheet>
  );
}
