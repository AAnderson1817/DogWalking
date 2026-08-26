// Calendar (phase 06): day + week views. Week view supports drag-to-
// reschedule across days (scheduled walks only, and only where the device has
// a fine pointer — HTML5 drag-and-drop does not fire on touch, review M11);
// tapping a walk opens an action sheet (reschedule date/window, cancel,
// no-show, one-off report access), which is the path that works everywhere.
// Any empty slot can host a one-off walk.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { usePointerFine } from "@/hooks/usePointerFine";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { LoadError, loadErrorMessage } from "@/components/LoadError";
import { FormError, Input, Select } from "@/components/fields";
import { SegmentedTabs, TabPanel } from "@/components/SegmentedTabs";
import { Sheet } from "@/components/Sheet";
import { Spinner } from "@/components/Spinner";
import { LoadingState } from "@/components/StateField";
import { walkStatusTreatment } from "@/components/status-treatment";
import { WalkCard } from "@/components/WalkCard";
import {
  createWalk,
  listClients,
  listProperties,
  listServiceTypes,
  listWalksDetailed,
  materializeWalks,
  setWalkPets,
  listPets,
  updateWalk,
  walkPetNames,
  type WalkDetailed,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { dateLocal, time12 } from "@/lib/format";
import { todayLocal } from "@/lib/selectors";
import type { Clients, Pets, Properties, ServiceTypes } from "@/lib/types";
import { useDocumentTitle } from "@/lib/use-document-title";

type CalendarView = "day" | "week";
const CALENDAR_VIEWS = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
] as const satisfies ReadonlyArray<{ key: CalendarView; label: string }>;

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `iso`. */
function weekStart(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // iso 1..7
  return addDays(iso, 1 - dow);
}

export default function Calendar() {
  useDocumentTitle("Calendar");
  const navigate = useNavigate();
  const [view, setView] = useState<CalendarView>("day");
  const [anchor, setAnchor] = useState(() => todayLocal());
  const [walks, setWalks] = useState<WalkDetailed[] | null>(null);
  const [selected, setSelected] = useState<WalkDetailed | null>(null);
  const [oneOffDate, setOneOffDate] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const pointerFine = usePointerFine();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const from = view === "day" ? anchor : weekStart(anchor);
  const to = view === "day" ? anchor : addDays(weekStart(anchor), 6);

  const load = useCallback(async () => {
    setWalks(await listWalksDetailed({ from, to }));
  }, [from, to]);

  useEffect(() => {
    setLoadError(null);
    void load().catch((e) => setLoadError(loadErrorMessage(e)));
  }, [load]);

  async function reschedule(walkId: string, date: string, windowStart?: string, windowEnd?: string) {
    const patch: Record<string, string> = { scheduled_date: date };
    if (windowStart) patch.window_start = windowStart;
    if (windowEnd) patch.window_end = windowEnd;
    await updateWalk(walkId, patch);
    await load();
  }

  async function runMaterializer() {
    setBusy(true);
    setNotice(null);
    try {
      const { created } = await materializeWalks();
      setNotice(`Materializer created ${created} walk${created === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "materializer failed");
    } finally {
      setBusy(false);
    }
  }

  const days = useMemo(
    () => (view === "day" ? [anchor] : Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i))),
    [view, anchor],
  );

  if (loadError && walks === null) {
    return (
      <LoadError title="Couldn't load the calendar" message={loadError} onRetry={() => {
        setLoadError(null);
        return load().catch((e) => setLoadError(loadErrorMessage(e)));
      }} />
    );
  }
  if (walks === null) {
    return (
      <div className="page">
        <LoadingState label="Loading the calendar" />
      </div>
    );
  }

  const byDay = (day: string) =>
    walks
      .filter((w) => w.scheduled_date === day)
      .sort((a, b) => a.window_start.localeCompare(b.window_start));

  return (
    /* The week grid is the only production surface that is a grid rather than a
       reading measure, so it is the only one that leaves the 640px cap (spec
       05, review M20). Day view keeps 640 deliberately: `.walk-card` is
       `minmax(92px, 0.72fr) minmax(0, 1.7fr)`, and stretching that to 1120
       gives a 780px route line — a worse reading measure than the one shipping
       now. The loading and error returns above keep plain `.page` too. */
    <div className={view === "week" ? "page page--wide" : "page"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s-2)" }}>
        <h1>Calendar</h1>
        <SegmentedTabs
          idBase="calendar"
          label="Calendar view"
          tabs={CALENDAR_VIEWS}
          value={view}
          onChange={setView}
        />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "var(--s-3)" }}>
        <Button
          variant="ghost"
          aria-label={`Previous ${view}`}
          onClick={() => setAnchor(addDays(anchor, view === "day" ? -1 : -7))}
        >
          <span aria-hidden>←</span>
        </Button>
        <div style={{ textAlign: "center" }}>
          <span className="numeral" style={{ fontWeight: 600 }}>
            {view === "day"
              ? dateLocal(`${anchor}T12:00:00Z`)
              : `${dateLocal(`${from}T12:00:00Z`)} – ${dateLocal(`${to}T12:00:00Z`)}`}
          </span>
          <div>
            <button
              className="text-button"
              onClick={() => setAnchor(todayLocal())}
              style={{ fontSize: "var(--fs-12)" }}
            >
              Jump to today
            </button>
          </div>
        </div>
        <Button
          variant="ghost"
          aria-label={`Next ${view}`}
          onClick={() => setAnchor(addDays(anchor, view === "day" ? 1 : 7))}
        >
          <span aria-hidden>→</span>
        </Button>
      </div>

      <div style={{ marginTop: "var(--s-2)", display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
        <Button variant="ghost" onClick={() => void runMaterializer()} disabled={busy}>
          {busy ? <Spinner /> : "Run materializer"}
        </Button>
        {/* Persistent region: the notice confirms a reschedule or a cancel,
            which is exactly the outcome a screen-reader user cannot see. */}
        <span role="status" style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
          {notice || null}
        </span>
      </div>

      <TabPanel idBase="calendar" tabKey={view}>
      {view === "day" ? (
        <div className="walk-list" style={{ marginTop: "var(--s-4)" }}>
          {byDay(anchor).length === 0 ? (
            <Card><EmptyState title="Nothing scheduled" action={<Button variant="ghost" onClick={() => setOneOffDate(anchor)}>Add one-off walk</Button>} /></Card>
          ) : (
            <>
              {byDay(anchor).map((w) => (
                <WalkCard
                  key={w.id}
                  walk={{
                    windowStart: w.window_start,
                    windowEnd: w.window_end,
                    petNames: walkPetNames(w),
                    propertyLabel: w.property?.label ?? "",
                    status: w.status,
                    isOverage: w.is_overage,
                    clientName: w.client?.full_name,
                  }}
                  onClick={() => setSelected(w)}
                />
              ))}
              <Button variant="ghost" onClick={() => setOneOffDate(anchor)}>Add one-off walk</Button>
            </>
          )}
        </div>
      ) : (
        <div className="calendar-week" style={{ marginTop: "var(--s-4)" }}>
          {days.map((day, i) => (
            <div
              key={day}
              className={`calendar-week__day${day === todayLocal() ? " calendar-week__day--today" : ""}`}
              onDragOver={(e) => {
                if (dragId) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) {
                  setNotice(null);
                  void reschedule(dragId, day).catch((err) =>
                    setNotice(err instanceof Error ? err.message : "couldn't move the walk"),
                  );
                  setDragId(null);
                }
              }}
            >
              <div className="calendar-week__header">
                <div className="section-label">{DAY_LABELS[i]}</div>
                <div className="numeral" style={{ fontSize: "var(--fs-12)" }}>{day.slice(8)}</div>
              </div>
              {byDay(day).map((w) => {
                // Review M11. HTML5 drag-and-drop does not fire on touch —
                // no dragstart, no drop, nothing — so the affordance was a
                // promise the primary device could not keep. The tap path
                // (this same button opens an action sheet wired to the same
                // `reschedule()`) works everywhere and is what a phone gets.
                const draggable = w.status === "scheduled" && pointerFine;
                const treatment = walkStatusTreatment(w.status, w.is_overage);
                const petOrClient = walkPetNames(w)[0] ?? w.client?.full_name ?? "Walk";
                return (
                  <button
                    type="button"
                    key={w.id}
                    className={`calendar-walk calendar-walk--${treatment.badge}${draggable ? " calendar-walk--draggable" : ""}`}
                    draggable={draggable}
                    onDragStart={() => setDragId(w.id)}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => setSelected(w)}
                    title={`${walkPetNames(w).join(", ")} — ${w.client?.full_name ?? ""}`}
                    aria-label={`${treatment.label}: ${time12(w.window_start)}, ${petOrClient}`}
                  >
                    <span className="calendar-walk__summary">
                      {time12(w.window_start)} {petOrClient}
                    </span>
                    {treatment.badge !== "scheduled" && (
                      <span className="calendar-walk__status">{treatment.label}</span>
                    )}
                  </button>
                );
              })}
              <button
                type="button"
                className="text-button calendar-add-button"
                onClick={() => setOneOffDate(day)}
                aria-label={`Add walk on ${day}`}
                style={{ fontSize: "var(--fs-12)" }}
              >
                + Add
              </button>
            </div>
          ))}
        </div>
      )}
      </TabPanel>

      <WalkActionSheet
        walk={selected}
        onClose={() => setSelected(null)}
        onChanged={() => {
          setSelected(null);
          void load();
        }}
        onOpenWalk={(id) => navigate(`/walks/${id}/live`)}
        reschedule={reschedule}
      />

      <OneOffWalkSheet
        date={oneOffDate}
        onClose={() => setOneOffDate(null)}
        onCreated={() => {
          setOneOffDate(null);
          void load();
        }}
      />
    </div>
  );
}

function WalkActionSheet({
  walk,
  onClose,
  onChanged,
  onOpenWalk,
  reschedule,
}: {
  walk: WalkDetailed | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenWalk: (id: string) => void;
  reschedule: (id: string, date: string, ws?: string, we?: string) => Promise<void>;
}) {
  const [date, setDate] = useState("");
  const [ws, setWs] = useState("");
  const [we, setWe] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (walk) {
      setDate(walk.scheduled_date);
      setWs(walk.window_start.slice(0, 5));
      setWe(walk.window_end.slice(0, 5));
      setError(null);
    }
  }, [walk]);

  if (!walk) return null;
  const rescheduleable = walk.status === "scheduled";
  const treatment = walkStatusTreatment(walk.status, walk.is_overage);

  async function mark(status: "cancelled" | "no_show") {
    if (!walk) return;
    setBusy(true);
    setError(null);
    try {
      await updateWalk(walk.id, { status });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not update the walk");
    } finally {
      setBusy(false);
    }
  }

  async function submitReschedule(e: FormEvent) {
    e.preventDefault();
    if (!walk) return;
    setBusy(true);
    setError(null);
    try {
      await reschedule(walk.id, date, ws, we);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not reschedule the walk");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={walkPetNames(walk).join(" & ") || walk.client?.full_name || "Walk"}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
          <Badge status={treatment.badge}>{treatment.label}</Badge>
          <span style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
            {walk.scheduled_date} · {time12(walk.window_start)}–{time12(walk.window_end)}
          </span>
        </div>

        <Button full onClick={() => onOpenWalk(walk.id)}>
          {walk.status === "completed" ? "View report" : "Open walk mode"}
        </Button>

        {rescheduleable && (
          <form onSubmit={submitReschedule} style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            <span className="section-label">Reschedule</span>
            <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-2)" }}>
              <Input label="From" type="time" value={ws} onChange={(e) => setWs(e.target.value)} />
              <Input label="To" type="time" value={we} onChange={(e) => setWe(e.target.value)} />
            </div>
            <Button type="submit" variant="ghost" full disabled={busy}>
              Save new slot
            </Button>
          </form>
        )}

        {(walk.status === "scheduled" || walk.status === "in_progress") && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-2)" }}>
            <Button variant="danger" onClick={() => void mark("cancelled")} disabled={busy}>
              Cancel walk
            </Button>
            <Button variant="ghost" onClick={() => void mark("no_show")} disabled={busy}>
              No-show
            </Button>
          </div>
        )}

        <FormError message={error} />
      </div>
    </Sheet>
  );
}

function OneOffWalkSheet({
  date,
  onClose,
  onCreated,
}: {
  date: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const auth = useAuth();
  const [clients, setClients] = useState<Clients[]>([]);
  const [properties, setProperties] = useState<Properties[]>([]);
  const [services, setServices] = useState<ServiceTypes[]>([]);
  const [pets, setPets] = useState<Pets[]>([]);
  const [clientId, setClientId] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [selectedPets, setSelectedPets] = useState<string[]>([]);
  const [ws, setWs] = useState("12:00");
  const [we, setWe] = useState("13:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (date === null) return;
    void Promise.all([listClients(), listServiceTypes()]).then(([cs, sts]) => {
      setClients(cs);
      setServices(sts);
      setServiceId((prev) => prev || (sts.find((s) => s.is_default)?.id ?? sts[0]?.id ?? ""));
    });
  }, [date]);

  useEffect(() => {
    if (!clientId) {
      setProperties([]);
      setPets([]);
      return;
    }
    void listProperties(clientId).then((ps) => {
      setProperties(ps);
      setPropertyId(ps[0]?.id ?? "");
    });
    void listPets(clientId).then((ps) => {
      setPets(ps);
      setSelectedPets(ps.map((p) => p.id));
    });
  }, [clientId]);

  if (date === null) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!auth.operatorId || !clientId || !propertyId || !serviceId) return;
    setBusy(true);
    setError(null);
    try {
      const walk = await createWalk({
        operator_id: auth.operatorId,
        client_id: clientId,
        property_id: propertyId,
        service_type_id: serviceId,
        scheduled_date: date!,
        window_start: ws,
        window_end: we,
        status: "scheduled",
      });
      await setWalkPets(walk.id, auth.operatorId, selectedPets);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create walk");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={`One-off walk — ${date}`}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <Select label="Client" required value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">Choose…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.full_name}</option>
          ))}
        </Select>
        {clientId && (
          <>
            <Select label="Property" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </Select>
            <Select label="Service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              {services.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-2)" }}>
              <Input label="From" type="time" value={ws} onChange={(e) => setWs(e.target.value)} />
              <Input label="To" type="time" value={we} onChange={(e) => setWe(e.target.value)} />
            </div>
          </>
        )}
        <FormError message={error} />
        <Button type="submit" full disabled={busy || !clientId || !propertyId}>
          {busy ? <Spinner /> : "Create walk"}
        </Button>
      </form>
    </Sheet>
  );
}
