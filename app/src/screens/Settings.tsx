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
import { Spinner } from "@/components/Spinner";
import { EmptyState } from "@/components/EmptyState";
import {
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
import { money } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";

type Cycle = "weekly" | "monthly";
type Rollover = "none" | "capped" | "unlimited";

export default function Settings() {
  useDocumentTitle("Settings");
  const [operator, setOperator] = useState<Operators | null>(null);
  const [services, setServices] = useState<ServiceTypes[]>([]);
  const [plans, setPlans] = useState<Plans[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [op, st, pl] = await Promise.all([
        getMyOperator(),
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
  }, []);

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
        onChanged={(next, msg) => {
          setServices(next);
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
  onChanged: (next: ServiceTypes[], msg: string) => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [cost, setCost] = useState("1");
  const [surcharge, setSurcharge] = useState("0");
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    try {
      const created = await createServiceType({
        name: name.trim(),
        duration_minutes: Number(minutes),
        credit_cost: Number(cost),
        weekend_surcharge_credits: Number(surcharge),
      });
      onChanged([...services, created], `Added ${created.name}.`);
      setName("");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not add that service.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: ServiceTypes) {
    try {
      await deleteServiceType(s.id);
      onChanged(services.filter((x) => x.id !== s.id), `Removed ${s.name}.`);
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
      onChanged(services.map((x) => (x.id === s.id ? updated : x)), "Service renamed.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not rename that service.");
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-services">
      <h2 id="settings-services" className="section-label">Services</h2>
      <p className="settings-help">
        What you offer, and what each one costs in credits. A weekend surcharge
        is added on Saturdays and Sundays.
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
                <span className="settings-row__meta">
                  {s.duration_minutes} min · {s.credit_cost} credit
                  {s.credit_cost === 1 ? "" : "s"}
                  {s.weekend_surcharge_credits > 0
                    ? ` · +${s.weekend_surcharge_credits} weekend`
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
      </div>
      <Button onClick={() => void add()} disabled={busy || !name.trim()}>
        {busy ? <Spinner /> : "Add service"}
      </Button>
    </section>
  );
}

// ── Plans ──────────────────────────────────────────────────────────────────
function PlansSection({
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
        price_pence: Math.round(Number(price) * 100),
        cycle,
        rollover_policy: rollover,
        rollover_cap: rollover === "capped" ? Number(cap) : null,
        overage_rate_pence: Math.round(Number(overage) * 100),
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
        disabled={busy || !name.trim() || !price || !overage}
      >
        {busy ? <Spinner /> : "Create plan"}
      </Button>
    </section>
  );
}
