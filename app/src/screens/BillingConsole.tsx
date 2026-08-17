// Operator Money surface: payment activity, renewal context, failed-payment
// recovery, and plan changes through the change-plan edge function.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { LoadError, loadErrorMessage } from "@/components/LoadError";
import { MoneyValueRail } from "@/components/MoneyValueRail";
import { PaymentRow } from "@/components/PaymentRow";
import { FormError, Select } from "@/components/fields";
import { Sheet } from "@/components/Sheet";
import { Spinner } from "@/components/Spinner";
import { LoadingState } from "@/components/StateField";
import { paymentStatusTreatment } from "@/components/status-treatment";
import {
  changePlan,
  chargeOverage,
  listClients,
  listPaymentsDetailed,
  listPlans,
  type PaymentDetailed,
} from "@/lib/api";
import { dateLocal, money } from "@/lib/format";
import type {
  Clients,
  PaymentStatus,
  PaymentType,
  Payments,
  Plans,
} from "@/lib/types";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function BillingConsole() {
  useDocumentTitle("Money");
  const [clients, setClients] = useState<Clients[] | null>(null);
  const [plans, setPlans] = useState<Plans[]>([]);
  const [payments, setPayments] = useState<PaymentDetailed[]>([]);
  const [planChangeFor, setPlanChangeFor] = useState<Clients | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<PaymentStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<PaymentType | "all">("all");
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [cs, ps, pays] = await Promise.all([listClients(), listPlans(), listPaymentsDetailed()]);
    setClients(cs);
    setPlans(ps);
    setPayments(pays);
  }, []);

  useEffect(() => {
    setLoadError(null);
    void load().catch((e) => setLoadError(loadErrorMessage(e)));
  }, [load]);

  if (loadError && clients === null) {
    return (
      <LoadError title="Couldn't load the billing console" message={loadError} onRetry={() => {
        setLoadError(null);
        return load().catch((e) => setLoadError(loadErrorMessage(e)));
      }} />
    );
  }
  if (clients === null) {
    return (
      <div className="page">
        <LoadingState label="Loading Money" />
      </div>
    );
  }

  const planName = (id: string | null) => plans.find((p) => p.id === id)?.name ?? "—";
  const clientName = (id: string) => clients.find((c) => c.id === id)?.full_name ?? "";

  const renewals = clients
    .filter((c) => c.subscription_status === "active")
    .sort((a, b) => (a.current_period_end ?? "9999").localeCompare(b.current_period_end ?? "9999"));
  const pastDue = clients.filter((c) => c.subscription_status === "past_due");
  const filteredPayments = payments.filter((payment) =>
    (statusFilter === "all" || payment.status === statusFilter)
    && (typeFilter === "all" || payment.type === typeFilter));
  const activeFilterCount = Number(statusFilter !== "all") + Number(typeFilter !== "all");

  async function recharge(payment: Payments) {
    if (!payment.walk_id) return;
    setBusyId(payment.id);
    setNotice(null);
    try {
      const { payment: result } = await chargeOverage(payment.walk_id);
      setNotice(
        result.status === "succeeded"
          ? `Recovered ${money(result.amount_pence)} from ${clientName(payment.client_id)}.`
          : `Charge attempt: ${paymentStatusTreatment(result.status).label}.`,
      );
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Charge retry failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <h1>Money</h1>
      {/* Persistent region: this is where a re-charge or a plan change
          reports whether it actually went through. */}
      <p role="status" style={{ marginTop: "var(--s-2)", color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
        {notice || null}
      </p>

      <MoneyValueRail payments={payments} />

      <section style={{ marginTop: "var(--s-4)" }}>
        <div className="money-section-heading">
          <span className="section-label">Payments</span>
          <Button variant="ghost" onClick={() => setFilterOpen(true)}>
            Filter{activeFilterCount ? ` · ${activeFilterCount}` : ""}
          </Button>
        </div>
        {filteredPayments.length === 0 ? (
          <Card style={{ marginTop: "var(--s-2)" }}>
            <EmptyState title={payments.length ? "No matching payments" : "No payments yet"} />
          </Card>
        ) : (
          <div className="payment-ledger">
            {filteredPayments.map((payment) => (
              <div key={payment.id}>
                <PaymentRow payment={payment} showClient />
                {payment.status === "failed" && payment.type === "overage" && payment.walk_id && (
                  <div className="payment-recovery">
                    <span>Payment failed. Retry this walk charge.</span>
                    <Button
                      variant="ghost"
                      onClick={() => void recharge(payment)}
                      disabled={busyId === payment.id}
                    >
                      {busyId === payment.id ? <Spinner /> : "Retry charge"}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: "var(--s-6)" }}>
        <span className="section-label">Upcoming renewals</span>
        {renewals.length === 0 ? (
          <Card style={{ marginTop: "var(--s-2)" }}><EmptyState title="No active subscriptions" /></Card>
        ) : (
          <div className="money-plan-list">
            {renewals.map((c) => (
              <div key={c.id} className="money-plan-row">
                <div className="money-plan-row__main">
                  <Link to={`/clients/${c.id}`} style={{ fontWeight: 800, color: "var(--text)", textDecoration: "none" }}>
                    {c.full_name}
                  </Link>
                  <div className="money-plan-row__meta">
                    {planName(c.plan_id)}
                    {c.current_period_end ? ` · renews ${dateLocal(c.current_period_end)}` : " · renewal date syncs from Stripe"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
                  <span className="numeral" style={{ fontWeight: 800 }}>{c.credit_balance}</span>
                  <Button variant="ghost" onClick={() => setPlanChangeFor(c)}>Change plan</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: "var(--s-6)" }}>
        <span className="section-label">Past due</span>
        {pastDue.length === 0 ? (
          <Card style={{ marginTop: "var(--s-2)" }}>
            <EmptyState title="Nobody past due" hint="Stripe retries failed renewals automatically." />
          </Card>
        ) : (
          <div className="money-plan-list">
            {pastDue.map((c) => (
              <div key={c.id} className="money-plan-row">
                <div className="money-plan-row__main">
                  <Link to={`/clients/${c.id}`} style={{ fontWeight: 800, color: "var(--text)", textDecoration: "none" }}>
                    {c.full_name}
                  </Link>
                  <div className="money-plan-row__meta">
                    {planName(c.plan_id)} · Stripe smart retries in progress
                  </div>
                </div>
                <Badge status="attention">Past due</Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Filter payments">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          <Select
            label="Status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as PaymentStatus | "all")}
          >
            <option value="all">All statuses</option>
            <option value="succeeded">Collected</option>
            <option value="pending">Processing</option>
            <option value="failed">Needs attention</option>
            <option value="refunded">Refunded</option>
          </Select>
          <Select
            label="Type"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as PaymentType | "all")}
          >
            <option value="all">All payment types</option>
            <option value="subscription">Subscription</option>
            <option value="overage">Walk overage</option>
          </Select>
          <Button
            variant="ghost"
            onClick={() => {
              setStatusFilter("all");
              setTypeFilter("all");
            }}
            disabled={activeFilterCount === 0}
          >
            Clear filters
          </Button>
          <Button full onClick={() => setFilterOpen(false)}>
            Show {filteredPayments.length} {filteredPayments.length === 1 ? "payment" : "payments"}
          </Button>
        </div>
      </Sheet>

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
      const result = await changePlan(client.id, planId);
      onChanged(
        result.pending
          ? `Plan change queued for ${client.full_name}; Stripe will confirm it shortly and credits will update from the webhook.`
          : `Plan changed — ${client.full_name} now holds ${result.new_balance} credits (upgrades prorate, downgrades never claw back).`,
      );
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
        <FormError message={error} />
        <Button full onClick={() => void submit()} disabled={busy || !planId}>
          {busy ? <Spinner /> : "Change plan"}
        </Button>
      </div>
    </Sheet>
  );
}
