// Booking (phase 07): request a one-off walk with explicit credit cost vs
// balance; insufficient balance requires an overage-price confirmation at
// the plan rate. Manage view: upcoming walks with cancel gated by the
// operator's cutoff (server-enforced by the 0008 guard).
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Input, Select } from "@/components/fields";
import { Sheet } from "@/components/Sheet";
import { Spinner } from "@/components/Spinner";
import { WalkCard } from "@/components/WalkCard";
import {
  cancelOwnWalk,
  createWalk,
  getMyClient,
  getMyOperatorView,
  getPlan,
  listPets,
  listProperties,
  listServiceTypes,
  listWalksDetailed,
  setWalkPets,
  walkPetNames,
  withinCancellationWindow,
  type MyOperatorView,
  type WalkDetailed,
} from "@/lib/api";
import { effectiveWalkCost } from "@/lib/credits";
import { gbp, walkTime } from "@/lib/format";
import { todayLondon } from "@/lib/selectors";
import type { Clients, Pets, Plans, Properties, ServiceTypes } from "@/lib/types";

export default function Booking() {
  const [client, setClient] = useState<Clients | null>(null);
  const [operator, setOperator] = useState<MyOperatorView | null>(null);
  const [plan, setPlan] = useState<Plans | null>(null);
  const [services, setServices] = useState<ServiceTypes[]>([]);
  const [properties, setProperties] = useState<Properties[]>([]);
  const [pets, setPets] = useState<Pets[]>([]);
  const [upcoming, setUpcoming] = useState<WalkDetailed[]>([]);

  const [date, setDate] = useState("");
  const [ws, setWs] = useState("12:00");
  const [we, setWe] = useState("13:00");
  const [serviceId, setServiceId] = useState("");
  const [selectedPets, setSelectedPets] = useState<string[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [confirmOverage, setConfirmOverage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState(false);

  const load = useCallback(async () => {
    const me = await getMyClient();
    if (!me) return;
    const [op, sts, props, ps, walks, p] = await Promise.all([
      getMyOperatorView(),
      listServiceTypes(),
      listProperties(me.id),
      listPets(me.id),
      listWalksDetailed({ from: todayLondon() }),
      me.plan_id ? getPlan(me.plan_id) : Promise.resolve(null),
    ]);
    setClient(me);
    setOperator(op);
    setServices(sts);
    setProperties(props);
    setPets(ps);
    setPlan(p);
    setUpcoming(walks.filter((w) => w.status === "scheduled"));
    setServiceId((prev) => prev || (sts.find((s) => s.is_default)?.id ?? sts[0]?.id ?? ""));
    setPropertyId((prev) => prev || (props[0]?.id ?? ""));
    setSelectedPets((prev) => (prev.length ? prev : ps.map((x) => x.id)));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const service = services.find((s) => s.id === serviceId) ?? null;
  const cost = useMemo(
    () => (service && date ? effectiveWalkCost(service, date) : null),
    [service, date],
  );
  const balance = client?.credit_balance ?? 0;
  const needsOverage = cost !== null && cost > balance;
  const overagePence = plan?.overage_rate_pence ?? null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!client || !operator || !date || !propertyId || !serviceId) return;
    if (needsOverage && !confirmOverage) {
      setError("confirm the overage price to continue");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const walk = await createWalk({
        operator_id: operator.id,
        client_id: client.id,
        property_id: propertyId,
        service_type_id: serviceId,
        scheduled_date: date,
        window_start: ws,
        window_end: we,
        status: "scheduled",
      });
      await setWalkPets(walk.id, operator.id, selectedPets);
      setBooked(true);
      setDate("");
      setConfirmOverage(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "booking failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(walkId: string) {
    if (!window.confirm("Cancel this walk?")) return;
    try {
      await cancelOwnWalk(walkId);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "could not cancel");
    }
  }

  if (!client || !operator) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  }

  const cutoff = operator.cancellation_cutoff_hours;

  return (
    <div className="page">
      <h1>Book a walk</h1>

      <Card style={{ marginTop: "var(--s-4)" }}>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          <Input label="Date" type="date" required min={todayLondon()} value={date} onChange={(e) => setDate(e.target.value)} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-2)" }}>
            <Input label="From" type="time" value={ws} onChange={(e) => setWs(e.target.value)} />
            <Input label="To" type="time" value={we} onChange={(e) => setWe(e.target.value)} />
          </div>
          <Select label="Service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.credit_cost} credit{s.credit_cost === 1 ? "" : "s"}
                {s.weekend_surcharge_credits > 0 ? ` (+${s.weekend_surcharge_credits} weekend)` : ""}
              </option>
            ))}
          </Select>
          {properties.length > 1 && (
            <Select label="Property" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </Select>
          )}
          <div>
            <span className="field__label">Pets</span>
            {pets.map((p) => (
              <label key={p.id} style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={selectedPets.includes(p.id)}
                  onChange={() =>
                    setSelectedPets((prev) =>
                      prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                    )
                  }
                />
                {p.name}
              </label>
            ))}
          </div>

          {cost !== null && (
            <Card style={{ background: needsOverage ? "var(--amber)" : "var(--mist)", boxShadow: "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 600 }}>Cost</span>
                <span className="numeral" style={{ fontWeight: 700, fontSize: "var(--fs-20)" }}>
                  {cost} credit{cost === 1 ? "" : "s"}
                </span>
              </div>
              <div style={{ fontSize: "var(--fs-14)", marginTop: "var(--s-1)" }}>
                Your balance: <span className="numeral">{balance}</span>
              </div>
              {needsOverage && (
                <div style={{ marginTop: "var(--s-2)" }}>
                  <p style={{ fontSize: "var(--fs-14)", fontWeight: 600 }}>
                    Not enough credits — this walk will be charged in full
                    {overagePence != null ? ` at ${gbp(overagePence)}` : " at your plan's overage rate"}
                    to your card after completion.
                  </p>
                  <label style={{ display: "flex", gap: "var(--s-2)", alignItems: "center", marginTop: "var(--s-2)" }}>
                    <input
                      type="checkbox"
                      checked={confirmOverage}
                      onChange={(e) => setConfirmOverage(e.target.checked)}
                    />
                    I understand{overagePence != null ? ` — charge ${gbp(overagePence)}` : ""}
                  </label>
                </div>
              )}
            </Card>
          )}

          {error && <span className="field__error">{error}</span>}
          <Button type="submit" full disabled={busy || !date || (needsOverage && !confirmOverage)}>
            {busy ? <Spinner /> : "Request walk"}
          </Button>
        </form>
      </Card>

      <section style={{ marginTop: "var(--s-6)" }}>
        <span className="section-label">Upcoming walks</span>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
          {upcoming.length === 0 ? (
            <Card><EmptyState title="Nothing upcoming" /></Card>
          ) : (
            upcoming.map((w) => {
              const cancellable = withinCancellationWindow(w.scheduled_date, w.window_start, cutoff);
              return (
                <div key={w.id}>
                  <span className="section-label">{walkTime(w.scheduled_date, w.window_start, w.window_end)}</span>
                  <WalkCard
                    walk={{
                      windowStart: w.window_start,
                      windowEnd: w.window_end,
                      petNames: walkPetNames(w),
                      propertyLabel: w.property?.label ?? "",
                      status: w.status,
                    }}
                  />
                  <div style={{ marginTop: "var(--s-1)" }}>
                    {cancellable ? (
                      <Button variant="ghost" onClick={() => void cancel(w.id)}>Cancel</Button>
                    ) : (
                      <span style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
                        Within {cutoff} h of the walk — contact your walker to cancel.
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <Sheet open={booked} onClose={() => setBooked(false)} title="Walk requested">
        <p style={{ color: "var(--text-2)" }}>
          Your walk is on the schedule. You'll get a report card when it's done.
        </p>
        <div style={{ marginTop: "var(--s-3)" }}>
          <Button full onClick={() => setBooked(false)}>Done</Button>
        </div>
      </Sheet>
    </div>
  );
}
