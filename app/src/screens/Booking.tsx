// Booking (phase 07): request a one-off walk with explicit credit cost vs
// balance; insufficient balance requires an overage-price confirmation at
// the plan rate. Manage view: upcoming walks with cancel gated by the
// operator's cutoff (server-enforced by the 0008 guard).
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { LoadError, loadErrorMessage } from "@/components/LoadError";
import { FormError, Input, Select } from "@/components/fields";
import { Sheet } from "@/components/Sheet";
import { Spinner } from "@/components/Spinner";
import { LoadingState, StateField } from "@/components/StateField";
import { WalkCard } from "@/components/WalkCard";
import {
  bookWalk,
  cancelOwnWalk,
  getMyClient,
  getMyOperatorView,
  getPlan,
  listPets,
  listProperties,
  listServiceTypes,
  listWalksDetailed,
  walkPetNames,
  withinCancellationWindow,
  type MyOperatorView,
  type WalkDetailed,
} from "@/lib/api";
import { availableCredits, committedCredits, effectiveWalkCost } from "@/lib/credits";
import { bookingChargePence, overageBookingGate } from "@/lib/visit-price";
import { money, walkTime } from "@/lib/format";
import { todayLocal } from "@/lib/selectors";
import type { Clients, Pets, Plans, Properties, ServiceTypes } from "@/lib/types";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useAuth } from "@/lib/auth-context";

export default function Booking() {
  useDocumentTitle("Book a walk");
  const auth = useAuth();
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

  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const me = await getMyClient(auth.session?.user.id);
    if (!me) throw new Error("We couldn't load your account. Please try again.");
    const [op, sts, props, ps, walks, p] = await Promise.all([
      getMyOperatorView(),
      listServiceTypes(),
      listProperties(me.id),
      listPets(me.id),
      listWalksDetailed({ from: todayLocal() }),
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
  }, [auth.session?.user.id]);

  useEffect(() => {
    setLoadError(null);
    void load().catch((e) => setLoadError(loadErrorMessage(e)));
  }, [load]);

  const service = services.find((s) => s.id === serviceId) ?? null;
  const cost = useMemo(
    () => (service && date ? effectiveWalkCost(service, date) : null),
    [service, date],
  );
  const balance = client?.credit_balance ?? 0;
  /**
   * Review H12. This compared the walk's cost against the RAW balance, so a
   * client with two credits could book three walks and see the overage
   * confirmation on none of them — each is individually affordable at the
   * moment it is booked, and billing happens at completion. The third walk
   * then fired an off-session charge they had never been shown.
   *
   * Already-booked walks are a claim on the balance, so they are counted.
   */
  const committed = useMemo(
    () =>
      committedCredits(upcoming, (w) => {
        const svc = services.find((x) => x.id === (w as { service_type_id?: string }).service_type_id);
        const when = (w as { scheduled_date?: string }).scheduled_date;
        return svc && when ? effectiveWalkCost(svc, when) : 0;
      }),
    [upcoming, services],
  );
  const available = availableCredits(balance, committed);
  const needsOverage = cost !== null && cost > available;
  // The figure quoted here mirrors the charge path's resolution (H32): the
  // plan's overage rate for a plan client, the service's visit price for a
  // pay-per-visit client. Null only when the operator has priced neither —
  // and a null figure BLOCKS an overage booking rather than asking the
  // client to confirm an unquantified charge: the walk could be priced
  // after booking (0044's backfill fills un-priced scheduled walks the
  // moment the operator sets a price), and "I understand" with no number
  // is not consent to whatever that number turns out to be (H12; caught in
  // adversarial review).
  const chargePence = bookingChargePence(plan, service);
  const chargeGate = overageBookingGate(needsOverage, chargePence);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!client || !operator) return;
    // Every missing precondition gets a visible message — a silent return
    // here reads as "the button did nothing".
    if (!date) {
      setError("pick a date for the walk");
      return;
    }
    if (!propertyId) {
      setError("no address on file yet — ask your walker to add your property first");
      return;
    }
    if (!serviceId) {
      setError("pick a service");
      return;
    }
    if (selectedPets.length === 0) {
      setError(pets.length === 0
        ? "no pets on file yet — ask your walker to add your dog first"
        : "select at least one pet");
      return;
    }
    if (chargeGate === "blocked") {
      setError(
        "this walk would need a card charge, and your walker hasn't set a price for it yet — "
          + "ask them to set a visit price or add credits, then book",
      );
      return;
    }
    if (chargeGate === "confirm" && !confirmOverage) {
      setError("confirm the overage price to continue");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Atomic: the walk and its pets are created in one transaction, so a
      // mid-write failure can't orphan a petless walk and a retry can't
      // double-book.
      await bookWalk({
        property_id: propertyId,
        service_type_id: serviceId,
        scheduled_date: date,
        window_start: ws,
        window_end: we,
        pet_ids: selectedPets,
      });
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

  if (loadError && !client) {
    return (
      <LoadError title="Couldn't load booking" message={loadError} onRetry={() => {
        setLoadError(null);
        return load().catch((e) => setLoadError(loadErrorMessage(e)));
      }} />
    );
  }
  if (!client || !operator) {
    return (
      <div className="page">
        <LoadingState label="Loading booking options" />
      </div>
    );
  }

  const cutoff = operator.cancellation_cutoff_hours;

  return (
    <div className="page">
      <h1>Book a walk</h1>

      {(properties.length === 0 || pets.length === 0) && (
        <div style={{ marginTop: "var(--s-4)" }}>
          <StateField
            compact
            tone="attention"
            label="Setup required"
            title="Booking isn't available yet"
            detail={`Your walker still needs to add ${
              properties.length === 0 && pets.length === 0
                ? "your address and your dog"
                : properties.length === 0
                  ? "your address"
                  : "your dog"
            } to your account.`}
          />
        </div>
      )}

      <Card style={{ marginTop: "var(--s-4)" }}>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          <Input label="Date" type="date" required min={todayLocal()} value={date} onChange={(e) => setDate(e.target.value)} />
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
            <Card className={`booking-cost${needsOverage ? " booking-cost--overage" : ""}`}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 600 }}>Cost</span>
                <span className="numeral" style={{ fontWeight: 700, fontSize: "var(--fs-20)" }}>
                  {cost} credit{cost === 1 ? "" : "s"}
                </span>
              </div>
              <div style={{ fontSize: "var(--fs-14)", marginTop: "var(--s-1)" }}>
                Your balance: <span className="numeral">{balance}</span>
                {committed > 0 && (
                  <>
                    {" — "}
                    <span className="numeral">{committed}</span> already booked,{" "}
                    <span className="numeral">{available}</span> left
                  </>
                )}
              </div>
              {chargeGate === "confirm" && chargePence != null && (
                <div style={{ marginTop: "var(--s-2)" }}>
                  <p style={{ fontSize: "var(--fs-14)", fontWeight: 600 }}>
                    Not enough credits — this walk will be charged in full
                    at {money(chargePence)} to your card after completion.
                  </p>
                  <label style={{ display: "flex", gap: "var(--s-2)", alignItems: "center", marginTop: "var(--s-2)" }}>
                    <input
                      type="checkbox"
                      checked={confirmOverage}
                      onChange={(e) => setConfirmOverage(e.target.checked)}
                    />
                    I understand — charge {money(chargePence)}
                  </label>
                </div>
              )}
              {chargeGate === "blocked" && (
                <p style={{ fontSize: "var(--fs-14)", fontWeight: 600, marginTop: "var(--s-2)" }}>
                  {/* No figure exists to confirm, so there is nothing honest
                      to ask the client to agree to — booking this walk is
                      blocked in submit() with the same explanation. */}
                  Not enough credits, and your walker hasn&rsquo;t set a price for
                  charging this walk to your card yet — ask them to set a visit
                  price, or top up your credits first.
                </p>
              )}
            </Card>
          )}

          <FormError message={error} />
          {/* Only hard-block on an unbookable account (no address/pets); every
              other precondition is validated in submit() with a specific
              message, so those branches stay reachable. */}
          <Button
            type="submit"
            full
            disabled={busy || properties.length === 0 || pets.length === 0}
          >
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
