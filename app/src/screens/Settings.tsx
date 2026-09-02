// Settings — operator configuration (review B6).
//
// Before this screen existed, a new operator could not create a plan, could
// not create or rename a service type, and could not change their business
// name, timezone or low-credit threshold after signup. The database has
// always granted full CRUD on both tables with correct operator_id policies
// (0004) and `updateOperator` was already written with zero importers — this
// was purely a missing UI.
//
// It mattered more than "unconfigured": with no plan, `clients.plan_id` stays
// null, every walk is marked overage at a zero balance, and the overage path
// used to fire a payment_failed notification at the PET OWNER for every single
// walk. The un-configured state actively dunned the operator's own customers.
// That half is fixed in _lib/overage.ts; this is the half that lets them
// configure it in the first place.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/Button";
import { FormError, Input, Select } from "@/components/fields";
import { MfaSection } from "@/components/MfaSection";
import { PushSection } from "@/components/PushSection";
import { Spinner } from "@/components/Spinner";
import { EmptyState } from "@/components/EmptyState";
import {
  createOperatorCheckout,
  createOperatorPortal,
  createPlan,
  createServiceType,
  deleteServiceType,
  getMyOperator,
  listPlans,
  listServiceTypes,
  updateOperator,
  updatePlan,
  updateServiceType,
} from "@/lib/api";
import type { Operators, Plans, ServiceTypes } from "@/lib/types";
import { dateLocal, money } from "@/lib/format";
import { PLATFORM_PRICE_PENCE, TRIAL_KEEP_FLOOR_MS } from "@/lib/operator-access";
import { parseVisitPriceInput } from "@/lib/visit-price";
import { centsFrom, planFormReady } from "@/lib/plan-form";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useAuth } from "@/lib/auth-context";

type Cycle = "weekly" | "monthly";
type Rollover = "none" | "capped" | "unlimited";

export default function Settings() {
  useDocumentTitle("Settings");
  const auth = useAuth();
  const [operator, setOperator] = useState<Operators | null>(null);
  const [services, setServices] = useState<ServiceTypes[]>([]);
  const [plans, setPlans] = useState<Plans[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [op, st, pl] = await Promise.all([
        getMyOperator(auth.session?.user.id),
        listServiceTypes(),
        listPlans(),
      ]);
      setOperator(op);
      setServices(st);
      setPlans(pl);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your settings.");
    } finally {
      setLoading(false);
    }
  }, [auth.session?.user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <div className="page"><Spinner /></div>;

  return (
    <div className="page">
      <h1>Settings</h1>
      <p role="status" className="settings-notice">{notice || null}</p>
      <FormError message={error} />

      {operator && (
        <BusinessSection
          operator={operator}
          onSaved={(o) => {
            setOperator(o);
            setNotice("Business details saved.");
          }}
          onError={setError}
        />
      )}

      <ServicesSection
        services={services}
        onChanged={(update, msg) => {
          // Functional, because two blur-triggered saves can be in flight at
          // once (rename row A, tab straight into row B's price): each
          // resolver must rebase onto the LATEST list, or whichever response
          // lands last silently reverts the other row's change in UI state
          // while the server keeps both (caught in adversarial review).
          setServices(update);
          setNotice(msg);
        }}
        onError={setError}
      />

      <PlansSection
        plans={plans}
        onChanged={(next, msg) => {
          setPlans(next);
          setNotice(msg);
        }}
        onError={setError}
      />

      {operator && <SubscriptionSection operator={operator} onError={setError} />}

      <MfaSection />
      <PushSection />
    </div>
  );
}

// ── Business ───────────────────────────────────────────────────────────────
function BusinessSection({
  operator,
  onSaved,
  onError,
}: {
  operator: Operators;
  onSaved: (o: Operators) => void;
  onError: (m: string) => void;
}) {
  const [businessName, setBusinessName] = useState(operator.business_name);
  const [displayName, setDisplayName] = useState(operator.display_name);
  const [phone, setPhone] = useState(operator.phone ?? "");
  const [threshold, setThreshold] = useState(String(operator.low_credit_threshold));
  // Review H5. How long a walk's GPS trace is kept. It is a business decision,
  // so it is a setting rather than a constant in a migration — a constant
  // would make the answer ours.
  const [retention, setRetention] = useState(String(operator.gps_retention_days));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const n = Number(threshold);
      if (!Number.isInteger(n) || n < 0) {
        onError("Low-credit warning must be a whole number of credits, 0 or more.");
        return;
      }
      const days = Number(retention);
      if (!Number.isInteger(days) || days < 0 || days > 3650) {
        onError("Route history must be a whole number of days between 0 and 3650.");
        return;
      }
      onSaved(
        await updateOperator(operator.id, {
          business_name: businessName.trim(),
          display_name: displayName.trim(),
          phone: phone.trim() || null,
          low_credit_threshold: n,
          gps_retention_days: days,
        }),
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save your business details.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-business">
      <h2 id="settings-business" className="section-label">Business</h2>
      <div className="settings-grid">
        <Input
          label="Business name"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
        />
        <Input
          label="Your name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <Input
          label="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
        />
        <Input
          label="Warn me at"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          inputMode="numeric"
        />
        <Input
          label="Keep route history for (days)"
          value={retention}
          onChange={(e) => setRetention(e.target.value)}
          inputMode="numeric"
          aria-describedby="retention-hint"
        />
      </div>
      <p id="retention-hint" className="settings-hint">
        A walk&rsquo;s GPS trace is deleted this many days after the walk. 0 keeps
        them indefinitely. The walk itself, and its billing record, are kept
        either way.
      </p>
      <div className="settings-grid">
      </div>
      <Button onClick={() => void save()} disabled={busy}>
        {busy ? <Spinner /> : "Save business details"}
      </Button>
    </section>
  );
}

// ── Service types ──────────────────────────────────────────────────────────
function ServicesSection({
  services,
  onChanged,
  onError,
}: {
  services: ServiceTypes[];
  /** Functional on purpose — see the call site in Settings(). */
  onChanged: (update: (prev: ServiceTypes[]) => ServiceTypes[], msg: string) => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [cost, setCost] = useState("1");
  const [surcharge, setSurcharge] = useState("0");
  const [visitPrice, setVisitPrice] = useState("");
  const [busy, setBusy] = useState(false);
  // A rejected price edit must be visible AT THE FIELD and the field must
  // revert to the last saved value — the page-level FormError sits above the
  // whole Business section and is off-viewport on a phone, and an uncontrolled
  // input otherwise keeps showing the rejected text as though it saved
  // (caught in adversarial review). The revision counter re-keys the Input so
  // React re-applies defaultValue.
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});
  const [priceRev, setPriceRev] = useState<Record<string, number>>({});

  function rejectPrice(id: string, reason: string) {
    setPriceErrors((prev) => ({ ...prev, [id]: reason }));
    setPriceRev((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }

  async function add() {
    const parsed = parseVisitPriceInput(visitPrice);
    if (!parsed.ok) {
      onError(parsed.reason);
      return;
    }
    setBusy(true);
    try {
      const created = await createServiceType({
        name: name.trim(),
        duration_minutes: Number(minutes),
        credit_cost: Number(cost),
        weekend_surcharge_credits: Number(surcharge),
        visit_price_pence: parsed.pence,
      });
      onChanged((prev) => [...prev, created], `Added ${created.name}.`);
      setName("");
      setVisitPrice("");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not add that service.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: ServiceTypes) {
    try {
      await deleteServiceType(s.id);
      onChanged((prev) => prev.filter((x) => x.id !== s.id), `Removed ${s.name}.`);
    } catch {
      // A service type in use is referenced by walks (ON DELETE RESTRICT), so
      // this is the common case rather than an exceptional one — say what to
      // do instead of surfacing a foreign-key message.
      onError(
        `${s.name} has walks booked against it, so it cannot be deleted. `
        + "Rename it instead, or leave it and stop scheduling it.",
      );
    }
  }

  async function rename(s: ServiceTypes, next: string) {
    if (!next.trim() || next === s.name) return;
    try {
      const updated = await updateServiceType(s.id, { name: next.trim() });
      onChanged((prev) => prev.map((x) => (x.id === s.id ? updated : x)), "Service renamed.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not rename that service.");
    }
  }

  async function reprice(s: ServiceTypes, raw: string) {
    const parsed = parseVisitPriceInput(raw);
    if (!parsed.ok) {
      rejectPrice(s.id, parsed.reason);
      return;
    }
    if (parsed.pence === s.visit_price_pence) return;
    try {
      const updated = await updateServiceType(s.id, { visit_price_pence: parsed.pence });
      setPriceErrors((prev) => ({ ...prev, [s.id]: "" }));
      // Setting a price for the first time also prices the un-priced walks
      // already on the calendar (0044's stamping trigger) — say so, because
      // an invisible side effect on the money path is how surprises happen.
      const firstPrice = s.visit_price_pence === null && parsed.pence !== null;
      onChanged(
        (prev) => prev.map((x) => (x.id === s.id ? updated : x)),
        parsed.pence === null
          ? `${s.name} is no longer offered pay-per-visit; walks already priced keep their price.`
          : firstPrice
          ? `${s.name} visits now charge ${money(parsed.pence)} — scheduled walks that had no price yet are included.`
          : `${s.name} visits now charge ${money(parsed.pence)} for newly scheduled walks.`,
      );
    } catch (e) {
      rejectPrice(s.id, e instanceof Error ? e.message : "Could not change that visit price.");
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-services">
      <h2 id="settings-services" className="section-label">Services</h2>
      <p className="settings-help">
        What you offer, and what each one costs in credits. A weekend surcharge
        is added on Saturdays and Sundays. The visit price is what a client
        with no plan is charged per completed visit — leave it empty to not
        offer pay-per-visit.
      </p>

      {services.length === 0
        ? <EmptyState title="No services yet" />
        : (
          <ul className="settings-list">
            {services.map((s) => (
              <li key={s.id} className="settings-row">
                <Input
                  label={`Name of ${s.name}`}
                  defaultValue={s.name}
                  onBlur={(e) => void rename(s, e.target.value)}
                />
                <Input
                  key={`${s.id}:${priceRev[s.id] ?? 0}:${s.visit_price_pence ?? ""}`}
                  label={`Visit price of ${s.name} ($)`}
                  defaultValue={s.visit_price_pence === null
                    ? ""
                    : (s.visit_price_pence / 100).toFixed(2)}
                  onBlur={(e) => void reprice(s, e.target.value)}
                  inputMode="decimal"
                  error={priceErrors[s.id] || undefined}
                />
                <span className="settings-row__meta">
                  {s.duration_minutes} min · {s.credit_cost} credit
                  {s.credit_cost === 1 ? "" : "s"}
                  {s.weekend_surcharge_credits > 0
                    ? ` · +${s.weekend_surcharge_credits} weekend`
                    : ""}
                  {s.visit_price_pence !== null
                    ? ` · ${money(s.visit_price_pence)}/visit`
                    : ""}
                </span>
                <Button variant="ghost" onClick={() => void remove(s)}>Remove</Button>
              </li>
            ))}
          </ul>
        )}

      <div className="settings-grid">
        <Input label="New service" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          label="Minutes"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          inputMode="numeric"
        />
        <Input
          label="Credits"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          inputMode="numeric"
        />
        <Input
          label="Weekend extra"
          value={surcharge}
          onChange={(e) => setSurcharge(e.target.value)}
          inputMode="numeric"
        />
        <Input
          label="Visit price ($)"
          value={visitPrice}
          onChange={(e) => setVisitPrice(e.target.value)}
          inputMode="decimal"
        />
      </div>
      <Button onClick={() => void add()} disabled={busy || !name.trim()}>
        {busy ? <Spinner /> : "Add service"}
      </Button>
    </section>
  );
}

// ── Plans ──────────────────────────────────────────────────────────────────
// Exported for Settings.plans.test.tsx, which pins that the button consults
// the rule in lib/plan-form.ts — a guard correct in `lib/` and ignored by
// the screen is a shape this repository has recorded more than once.
export function PlansSection({
  plans,
  onChanged,
  onError,
}: {
  plans: Plans[];
  onChanged: (next: Plans[], msg: string) => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [credits, setCredits] = useState("8");
  const [price, setPrice] = useState("");
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [rollover, setRollover] = useState<Rollover>("none");
  const [cap, setCap] = useState("");
  const [overage, setOverage] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    try {
      const { plan } = await createPlan({
        name: name.trim(),
        credits_per_cycle: Number(credits),
        // Entered in dollars, stored in cents — the *_pence columns hold cents.
        // The same conversion the button gates on (plan-form.ts), so a draft
        // the button accepts is the draft the server receives.
        price_pence: centsFrom(price) ?? 0,
        cycle,
        rollover_policy: rollover,
        rollover_cap: rollover === "capped" ? Number(cap) : null,
        overage_rate_pence: centsFrom(overage) ?? 0,
      });
      onChanged([...plans, plan], `Created ${plan.name}.`);
      setName("");
      setPrice("");
      setOverage("");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not create that plan.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(p: Plans) {
    try {
      const updated = await updatePlan(p.id, { active: !p.active });
      onChanged(
        plans.map((x) => (x.id === p.id ? updated : x)),
        updated.active ? `${p.name} is available again.` : `${p.name} is no longer offered.`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not update that plan.");
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-plans">
      <h2 id="settings-plans" className="section-label">Plans</h2>
      <p className="settings-help">
        Clients subscribe to a plan and get credits each cycle. A walk that
        cannot be covered by credits is charged in full at the overage rate —
        never part-paid from credits.{" "}
        <Link to="/billing">Stripe must be connected</Link> before a plan can be
        created, because the price is created on your own Stripe account.
      </p>

      {plans.length === 0
        ? <EmptyState title="No plans yet" />
        : (
          <ul className="settings-list">
            {plans.map((p) => (
              <li key={p.id} className="settings-row">
                <span className="settings-row__name">{p.name}</span>
                <span className="settings-row__meta">
                  {money(p.price_pence)}/{p.cycle === "weekly" ? "week" : "month"} ·{" "}
                  {p.credits_per_cycle} credits · {money(p.overage_rate_pence)} overage
                  {p.active ? "" : " · not offered"}
                </span>
                <Button variant="ghost" onClick={() => void toggle(p)}>
                  {p.active ? "Stop offering" : "Offer again"}
                </Button>
              </li>
            ))}
          </ul>
        )}

      <div className="settings-grid">
        <Input label="Plan name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          label="Credits per cycle"
          value={credits}
          onChange={(e) => setCredits(e.target.value)}
          inputMode="numeric"
        />
        <Input
          label="Price ($)"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          inputMode="decimal"
        />
        <Select
          label="Billed"
          value={cycle}
          onChange={(e) => setCycle(e.target.value as Cycle)}
        >
          <option value="monthly">Monthly</option>
          <option value="weekly">Weekly</option>
        </Select>
        <Select
          label="Unused credits"
          value={rollover}
          onChange={(e) => setRollover(e.target.value as Rollover)}
        >
          <option value="none">Expire at the end of the cycle</option>
          <option value="capped">Roll over, up to a cap</option>
          <option value="unlimited">Roll over, no cap</option>
        </Select>
        {rollover === "capped" && (
          <Input
            label="Cap"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            inputMode="numeric"
          />
        )}
        <Input
          label="Overage rate ($ per walk)"
          value={overage}
          onChange={(e) => setOverage(e.target.value)}
          inputMode="decimal"
        />
      </div>
      <Button
        onClick={() => void add()}
        disabled={busy || !planFormReady({ name, price, overage })}
      >
        {busy ? <Spinner /> : "Create plan"}
      </Button>
    </section>
  );
}

// ── Sanpo subscription (review H31) ────────────────────────────────────────
//
// The operator's own $49/month. Reads the columns the 0045 migration made
// service-role-only to WRITE — the row is self-readable, so the screen can
// say what is true without another endpoint. Both launchers use the H32
// persistent-link pattern: window.open with "noopener" returns null even on
// success, so the rendered link is the reliable surface.
function SubscriptionSection({
  operator,
  onError,
}: {
  operator: Operators;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [payLink, setPayLink] = useState<{ label: string; url: string } | null>(null);

  const status = operator.platform_subscription_status;
  const trialEndsMs = operator.trial_ends_at ? Date.parse(operator.trial_ends_at) : NaN;
  const inTrial = Number.isFinite(trialEndsMs) && Date.now() < trialEndsMs;
  // Stripe refuses a trial_end under 48h out, so the checkout DROPS the
  // trial inside that window and billing starts at once — the sentence
  // below must say so, or a money screen promises days it will not deliver
  // (H12's truthfulness rule; the floor is pinned against the edge
  // function's by platform-price.test.ts).
  const keepsTrial = inTrial && trialEndsMs - Date.now() >= TRIAL_KEEP_FLOOR_MS;
  const hasBilling = Boolean(operator.platform_customer_id);
  const live = status === "active" || status === "past_due" || status === "paused";

  const statusLine = status === "active"
    ? `Active — ${money(PLATFORM_PRICE_PENCE)}/month.`
    : status === "past_due"
    ? "Payment failed — Stripe is retrying your card. Update it in Manage billing."
    : status === "paused"
    ? "Paused. Resume it from Manage billing."
    : status === "cancelled"
    ? "Cancelled."
    : keepsTrial
    ? `Free trial until ${dateLocal(operator.trial_ends_at)} — subscribe any time; your trial days are kept.`
    : inTrial
    ? `Free trial until ${dateLocal(operator.trial_ends_at)} — subscribing this close to the end starts billing right away.`
    : "Your free trial has ended.";

  async function open(kind: "checkout" | "portal") {
    setBusy(true);
    try {
      const { url } = kind === "checkout"
        ? await createOperatorCheckout()
        : await createOperatorPortal();
      if (!url) throw new Error("Stripe did not return a link");
      setPayLink({
        label: kind === "checkout" ? "Subscription checkout" : "Billing portal",
        url,
      });
      window.open(url, "_blank", "noopener");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not open Stripe.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-subscription">
      <h2 id="settings-subscription" className="section-label">Sanpo subscription</h2>
      <p>{statusLine}</p>
      <div style={{ display: "flex", gap: "var(--s-3)", flexWrap: "wrap" }}>
        {!live && (
          <Button onClick={() => void open("checkout")} disabled={busy}>
            {busy ? <Spinner /> : "Subscribe"}
          </Button>
        )}
        {hasBilling && (
          <Button variant="ghost" onClick={() => void open("portal")} disabled={busy}>
            {busy ? <Spinner /> : "Manage billing"}
          </Button>
        )}
      </div>
      {payLink && (
        <p style={{ fontSize: "var(--fs-14)" }}>
          {payLink.label}:{" "}
          <a href={payLink.url} target="_blank" rel="noreferrer">
            open or copy this link
          </a>{" "}
          if nothing opened.
        </p>
      )}
    </section>
  );
}
