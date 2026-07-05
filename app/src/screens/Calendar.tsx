// Calendar (phase 06): day + week views. Week view supports drag-to-
// reschedule across days (scheduled walks only); tapping a walk opens an
// action sheet (reschedule date/window, cancel, no-show, one-off report
// access). Any empty slot can host a one-off walk.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Input, Select } from "@/components/fields";
import { Sheet } from "@/components/Sheet";
import { Spinner } from "@/components/Spinner";
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
import { todayLondon } from "@/lib/selectors";
import type { Clients, Pets, Properties, ServiceTypes } from "@/lib/types";

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
  const navigate = useNavigate();
  const [view, setView] = useState<"day" | "week">("day");
  const [anchor, setAnchor] = useState(() => todayLondon());
  const [walks, setWalks] = useState<WalkDetailed[] | null>(null);
  const [selected, setSelected] = useState<WalkDetailed | null>(null);
  const [oneOffDate, setOneOffDate] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const from = view === "day" ? anchor : weekStart(anchor);
  const to = view === "day" ? anchor : addDays(weekStart(anchor), 6);

  const load = useCallback(async () => {
    setWalks(await listWalksDetailed({ from, to }));
  }, [from, to]);

  useEffect(() => {
    void load();
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

  if (walks === null) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  }

  const byDay = (day: string) =>
    walks
      .filter((w) => w.scheduled_date === day)
      .sort((a, b) => a.window_start.localeCompare(b.window_start));

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s-2)" }}>
        <h1>Calendar</h1>
        <div style={{ display: "flex", gap: "var(--s-1)" }}>
          <Button variant={view === "day" ? "primary" : "ghost"} onClick={() => setView("day")}>Day</Button>
          <Button variant={view === "week" ? "primary" : "ghost"} onClick={() => setView("week")}>Week</Button>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "var(--s-3)" }}>
        <Button variant="ghost" onClick={() => setAnchor(addDays(anchor, view === "day" ? -1 : -7))}>←</Button>
        <div style={{ textAlign: "center" }}>
          <span className="numeral" style={{ fontWeight: 600 }}>
            {view === "day" ? anchor : `${from} → ${to}`}
          </span>
          <div>
            <button
              onClick={() => setAnchor(todayLondon())}
              style={{ background: "none", border: 0, color: "var(--pine-600)", fontSize: "var(--fs-12)", cursor: "pointer" }}
            >
              Jump to today
            </button>
          </div>
        </div>
        <Button variant="ghost" onClick={() => setAnchor(addDays(anchor, view === "day" ? 1 : 7))}>→</Button>
      </div>

      <div style={{ marginTop: "var(--s-2)", display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
        <Button variant="ghost" onClick={() => void runMaterializer()} disabled={busy}>
          {busy ? <Spinner /> : "Run materializer"}
        </Button>
        {notice && <span style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>{notice}</span>}
      </div>

      {view === "day" ? (
        <div style={{ marginTop: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
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
        <div
          style={{
            marginTop: "var(--s-4)",
            display: "grid",
            gridTemplateColumns: "repeat(7, minmax(72px, 1fr))",
            gap: "var(--s-1)",
            overflowX: "auto",
          }}
        >
          {days.map((day, i) => (
            <div
              key={day}
              onDragOver={(e) => {
                if (dragId) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) {
                  void reschedule(dragId, day);
                  setDragId(null);
                }
              }}
              style={{
                background: day === todayLondon() ? "var(--mist)" : "var(--surface)",
                borderRadius: "var(--r-md)",
                padding: "var(--s-1)",
                minHeight: 160,
                boxShadow: "var(--shadow-1)",
              }}
            >
              <div style={{ textAlign: "center", marginBottom: "var(--s-1)" }}>
                <div className="section-label">{DAY_LABELS[i]}</div>
                <div className="numeral" style={{ fontSize: "var(--fs-12)" }}>{day.slice(8)}</div>
              </div>
              {byDay(day).map((w) => {
                const draggable = w.status === "scheduled";
                return (
                  <div
                    key={w.id}
                    draggable={draggable}
                    onDragStart={() => setDragId(w.id)}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => setSelected(w)}
                    title={`${walkPetNames(w).join(", ")} — ${w.client?.full_name ?? ""}`}
                    style={{
                      background: w.status === "cancelled" || w.status === "no_show"
                        ? "transparent"
                        : w.status === "in_progress"
                          ? "var(--teal-live)"
                          : w.status === "completed"
                            ? "var(--pine-600)"
                            : "var(--pine-800)",
                      color: w.status === "cancelled" || w.status === "no_show"
                        ? "var(--ink-faint)"
                        : w.status === "in_progress"
                          ? "var(--pine-950)"
                          : "var(--white)",
                      textDecoration: w.status === "cancelled" ? "line-through" : undefined,
                      borderRadius: "var(--r-sm)",
                      padding: "2px var(--s-1)",
                      fontSize: "var(--fs-12)",
                      fontWeight: 600,
                      marginBottom: 2,
                      cursor: draggable ? "grab" : "pointer",
                      border: w.status === "cancelled" || w.status === "no_show" ? "1px solid var(--mist)" : 0,
                    }}
                  >
                    {w.window_start.slice(0, 5)} {walkPetNames(w)[0] ?? w.client?.full_name ?? ""}
                  </div>
                );
              })}
              <button
                onClick={() => setOneOffDate(day)}
                aria-label={`Add walk on ${day}`}
                style={{
                  width: "100%",
                  border: 0,
                  background: "none",
                  color: "var(--ink-faint)",
                  cursor: "pointer",
                  fontSize: "var(--fs-12)",
                }}
              >
                +
              </button>
            </div>
          ))}
        </div>
      )}

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

  useEffect(() => {
    if (walk) {
      setDate(walk.scheduled_date);
      setWs(walk.window_start.slice(0, 5));
      setWe(walk.window_end.slice(0, 5));
    }
  }, [walk]);

  if (!walk) return null;
  const rescheduleable = walk.status === "scheduled";

  async function mark(status: "cancelled" | "no_show") {
    if (!walk) return;
    setBusy(true);
    try {
      await updateWalk(walk.id, { status });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function submitReschedule(e: FormEvent) {
    e.preventDefault();
    if (!walk) return;
    setBusy(true);
    try {
      await reschedule(walk.id, date, ws, we);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={walkPetNames(walk).join(" & ") || walk.client?.full_name || "Walk"}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
          <Badge status={walk.is_overage ? "overage" : walk.status} />
          <span style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
            {walk.scheduled_date} · {walk.window_start.slice(0, 5)}–{walk.window_end.slice(0, 5)}
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
        {error && <span className="field__error">{error}</span>}
        <Button type="submit" full disabled={busy || !clientId || !propertyId}>
          {busy ? <Spinner /> : "Create walk"}
        </Button>
      </form>
    </Sheet>
  );
}
