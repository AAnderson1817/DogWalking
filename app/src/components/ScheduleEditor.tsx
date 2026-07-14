// Recurring schedule management (phase 06), used from ClientDetail's
// Schedule tab: days-of-week picker, window, service type, pets, start/end
// dates, pause-window editor, deactivate (cancels future scheduled walks).
import { loadErrorMessage } from "@/components/LoadError";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { Input, Select } from "./fields";
import { Sheet } from "./Sheet";
import { Spinner } from "./Spinner";
import { time12 } from "@/lib/format";
import {
  createSchedule,
  deactivateSchedule,
  listPets,
  listProperties,
  listSchedulePets,
  listServiceTypes,
  setSchedulePets,
  updateSchedule,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { todayLocal } from "@/lib/selectors";
import type { Pets, Properties, RecurringSchedules, ServiceTypes } from "@/lib/types";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // iso 1..7

export function ScheduleTab({ clientId }: { clientId: string }) {
  const [schedules, setSchedules] = useState<RecurringSchedules[] | null>(null);
  const [serviceTypes, setServiceTypes] = useState<ServiceTypes[]>([]);
  const [properties, setProperties] = useState<Properties[]>([]);
  const [pets, setPets] = useState<Pets[]>([]);
  const [editing, setEditing] = useState<RecurringSchedules | "new" | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: scheds, error: schedErr }, sts, props, ps] = await Promise.all([
      supabase
        .from("recurring_schedules")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at"),
      listServiceTypes(),
      listProperties(clientId),
      listPets(clientId),
    ]);
    if (schedErr) throw schedErr; // don't render "no schedule" on a query error
    setSchedules((scheds as RecurringSchedules[]) ?? []);
    setServiceTypes(sts);
    setProperties(props);
    setPets(ps);
  }, [clientId]);

  const runLoad = useCallback(() => {
    setLoadError(null);
    return load().catch((e) => setLoadError(loadErrorMessage(e)));
  }, [load]);

  useEffect(() => {
    void runLoad();
  }, [runLoad]);

  if (loadError) {
    return (
      <Card>
        <EmptyState
          title="Couldn't load schedules"
          hint={loadError}
          action={<Button onClick={() => void runLoad()}>Retry</Button>}
        />
      </Card>
    );
  }
  if (schedules === null) return <Spinner />;

  const serviceName = (id: string) => serviceTypes.find((s) => s.id === id)?.name ?? "";
  const propertyLabel = (id: string) => properties.find((p) => p.id === id)?.label ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      <div>
        <Button
          variant="accent"
          onClick={() => setEditing("new")}
          disabled={properties.length === 0}
        >
          New recurring schedule
        </Button>
        {properties.length === 0 && (
          <p style={{ color: "var(--text-2)", fontSize: "var(--fs-12)", marginTop: "var(--s-1)" }}>
            Add a property first (Access tab).
          </p>
        )}
      </div>

      {schedules.length === 0 ? (
        <Card><EmptyState title="No recurring schedule" hint="Weekly patterns materialize into walks 14 days ahead." /></Card>
      ) : (
        schedules.map((s) => (
          <Card key={s.id} onClick={() => setEditing(s)} style={{ cursor: "pointer" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {s.days_of_week.map((d) => DAY_LABELS[d - 1]).join(" · ")}
                </div>
                <div style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
                  {time12(s.window_start)}–{time12(s.window_end)} · {serviceName(s.service_type_id)} · {propertyLabel(s.property_id)}
                </div>
                {s.paused_from && (
                  <div style={{ fontSize: "var(--fs-12)", color: "var(--orange-deep)", marginTop: "var(--s-1)", fontWeight: 800 }}>
                    Paused {s.paused_from} → {s.paused_until ?? "indefinitely"}
                  </div>
                )}
              </div>
              <Badge status={s.active ? "completed" : "cancelled"}>
                {s.active ? "active" : "inactive"}
              </Badge>
            </div>
          </Card>
        ))
      )}

      <ScheduleSheet
        key={editing === "new" ? "new" : editing?.id ?? "closed"}
        open={editing !== null}
        schedule={editing === "new" ? null : editing}
        clientId={clientId}
        serviceTypes={serviceTypes}
        properties={properties}
        pets={pets}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}

function ScheduleSheet({
  open,
  schedule,
  clientId,
  serviceTypes,
  properties,
  pets,
  onClose,
  onSaved,
}: {
  open: boolean;
  schedule: RecurringSchedules | null;
  clientId: string;
  serviceTypes: ServiceTypes[];
  properties: Properties[];
  pets: Pets[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth();
  const [days, setDays] = useState<number[]>(schedule?.days_of_week ?? [1, 3, 5]);
  const [windowStart, setWindowStart] = useState(schedule?.window_start.slice(0, 5) ?? "12:00");
  const [windowEnd, setWindowEnd] = useState(schedule?.window_end.slice(0, 5) ?? "13:00");
  const [serviceId, setServiceId] = useState(schedule?.service_type_id ?? serviceTypes[0]?.id ?? "");
  const [propertyId, setPropertyId] = useState(schedule?.property_id ?? properties[0]?.id ?? "");
  const [startDate, setStartDate] = useState(schedule?.start_date ?? todayLocal());
  const [endDate, setEndDate] = useState(schedule?.end_date ?? "");
  const [pausedFrom, setPausedFrom] = useState(schedule?.paused_from ?? "");
  const [pausedUntil, setPausedUntil] = useState(schedule?.paused_until ?? "");
  const [selectedPets, setSelectedPets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (schedule) {
      void listSchedulePets(schedule.id).then(setSelectedPets);
    } else {
      setSelectedPets(pets.map((p) => p.id)); // default: all the client's pets
    }
  }, [schedule, pets]);

  function toggleDay(d: number) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  }

  function togglePet(id: string) {
    setSelectedPets((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!auth.operatorId || days.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const fields = {
        days_of_week: days,
        window_start: windowStart,
        window_end: windowEnd,
        service_type_id: serviceId,
        property_id: propertyId,
        start_date: startDate,
        end_date: endDate || null,
        paused_from: pausedFrom || null,
        paused_until: pausedUntil || null,
      };
      const saved = schedule
        ? await updateSchedule(schedule.id, fields)
        : await createSchedule({
            ...fields,
            operator_id: auth.operatorId,
            client_id: clientId,
          });
      await setSchedulePets(saved.id, auth.operatorId, selectedPets);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save schedule");
    } finally {
      setBusy(false);
    }
  }

  async function deactivate() {
    if (!schedule) return;
    if (!window.confirm("Deactivate this schedule? Future scheduled walks will be cancelled; past walks are kept.")) return;
    setBusy(true);
    setError(null);
    try {
      await deactivateSchedule(schedule.id, todayLocal());
      onSaved();
    } catch (err) {
      // Surface the failure — deactivateSchedule flips active=false then
      // cancels future walks in a second statement; if the cancel half fails
      // the operator must know those walks are still live.
      setError(err instanceof Error ? err.message : "could not deactivate the schedule");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={schedule ? "Edit schedule" : "New schedule"}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <div>
          <span className="field__label">Days</span>
          <div style={{ display: "flex", gap: "var(--s-1)", marginTop: "var(--s-1)", flexWrap: "wrap" }}>
            {DAY_LABELS.map((label, i) => {
              const d = i + 1;
              const on = days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(d)}
                  aria-pressed={on}
                  style={{
                    minWidth: 44,
                    minHeight: 44,
                    borderRadius: "var(--r-md)",
                    border: 0,
                    fontWeight: 600,
                    background: on ? "var(--pine-800)" : "var(--mist)",
                    color: on ? "var(--white)" : "var(--ink-soft)",
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-2)" }}>
          <Input label="From" type="time" required value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
          <Input label="To" type="time" required value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
        </div>

        <Select label="Service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          {serviceTypes.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>

        <Select label="Property" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </Select>

        <div>
          <span className="field__label">Pets</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-1)", marginTop: "var(--s-1)" }}>
            {pets.map((p) => (
              <label key={p.id} style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
                <input type="checkbox" checked={selectedPets.includes(p.id)} onChange={() => togglePet(p.id)} />
                {p.name}
              </label>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-2)" }}>
          <Input label="Starts" type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <Input label="Ends (optional)" type="date" value={endDate ?? ""} onChange={(e) => setEndDate(e.target.value)} />
        </div>

        <div>
          <span className="field__label">Pause window (optional)</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-2)", marginTop: "var(--s-1)" }}>
            <Input label="Paused from" type="date" value={pausedFrom ?? ""} onChange={(e) => setPausedFrom(e.target.value)} />
            <Input label="Paused until" type="date" value={pausedUntil ?? ""} onChange={(e) => setPausedUntil(e.target.value)} />
          </div>
        </div>

        {error && <span className="field__error">{error}</span>}
        <Button type="submit" full disabled={busy || days.length === 0 || !serviceId || !propertyId}>
          {busy ? <Spinner /> : "Save schedule"}
        </Button>
        {schedule?.active && (
          <Button type="button" variant="danger" full onClick={() => void deactivate()} disabled={busy}>
            Deactivate — cancel future walks
          </Button>
        )}
      </form>
    </Sheet>
  );
}
