// Walk Mode (phase 05): night-walk theme. start → live GPS + broadcast →
// photos (compressed → Storage) → potty/fed toggles → notes → End & send →
// complete-walk edge fn → billing outcome banner → ReportCard preview.
// Exit is guarded while in_progress.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Textarea } from "@/components/fields";
import { MapView } from "@/components/MapView";
import { ReportCard } from "@/components/ReportCard";
import { Spinner } from "@/components/Spinner";
import { LoadingState, StateField } from "@/components/StateField";
import {
  paymentStatusTreatment,
  walkStatusTreatment,
} from "@/components/status-treatment";
import {
  completeWalk,
  getWalk,
  listWalkGpsPoints,
  listWalkPets,
  listWalkPhotos,
  signedPhotoUrl,
  updateWalk,
  uploadWalkPhoto,
  type CompleteWalkResult,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useGeolocation } from "@/hooks/useGeolocation";
import { useOnline } from "@/hooks/useOnline";
import { useWalkChannel } from "@/hooks/useWalkChannel";
import { pathDistanceM } from "@/lib/geo";
import { distanceKm, elapsed, money, time12 } from "@/lib/format";
import { compressImage } from "@/lib/image";
import {
  clearWalkSnapshot,
  isNetworkError,
  loadWalkSnapshot,
  saveWalkSnapshot,
} from "@/lib/walk-snapshot";
import type { Pets, Walks } from "@/lib/types";

export default function WalkMode() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <WalkModeInner walkId={id} />;
}

function WalkModeInner({ walkId }: { walkId: string }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [walk, setWalk] = useState<Walks | null>(null);
  const [pets, setPets] = useState<Pets[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [toggles, setToggles] = useState({ potty_pee: false, potty_poo: false, fed: false, watered: false });
  const [notes, setNotes] = useState("");
  const [photoPaths, setPhotoPaths] = useState<string[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<CompleteWalkResult | null>(null);
  const [reportPhotoUrls, setReportPhotoUrls] = useState<string[]>([]);
  const [offlineResumed, setOfflineResumed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const active = walk?.status === "in_progress" && !result;
  const geo = useGeolocation(active ?? false);
  const channel = useWalkChannel(walkId, "broadcast", auth.operatorId ?? "");
  const pendingPoints = channel.pendingPoints;
  const online = useOnline();
  const sentCount = useRef(0);

  useEffect(() => {
    void getWalk(walkId)
      .then(async (w) => {
        setWalk(w);
        setPets(await listWalkPets(walkId));
        setNotes(w.notes ?? "");
        // Resuming an in-progress walk after a reload: seed the route and
        // distance baseline from points already saved AND any still queued in
        // the offline outbox, so the report doesn't silently lose everything
        // walked before the reload (especially after an offline stretch, when
        // most of the trail is still in the outbox, not the DB yet).
        if (w.status === "in_progress") {
          const [saved, queued] = await Promise.all([
            listWalkGpsPoints(walkId),
            pendingPoints(),
          ]);
          const seen = new Set<string>();
          const merged: Array<{ lat: number; lng: number }> = [];
          for (const p of [...saved.map((x) => ({ lat: x.lat, lng: x.lng })), ...queued]) {
            const key = `${p.lat},${p.lng}`;
            if (!seen.has(key)) {
              seen.add(key);
              merged.push({ lat: p.lat, lng: p.lng });
            }
          }
          setResumedPoints(merged);
        }
        // Re-entering a completed walk: show its report.
        if (w.status === "completed") {
          const [photos, points] = await Promise.all([
            listWalkPhotos(walkId),
            listWalkGpsPoints(walkId),
          ]);
          setReportPhotoUrls(
            await Promise.all(photos.map((p) => signedPhotoUrl(p.storage_path).catch(() => ""))),
          );
          setResult({
            walk: w,
            billing: w.credits_debited > 0
              ? { outcome: "debited", cost_credits: w.credits_debited }
              : { outcome: w.is_overage ? "overage" : "debited" },
          });
          setStaticPoints(points.map((p) => ({ lat: p.lat, lng: p.lng })));
        }
      })
      .catch((e: unknown) => {
        // Offline mid-walk reload: the SW keeps REST network-only, so getWalk
        // fails. Fall back to the local snapshot to keep recording rather than
        // dead-ending (which would stop GPS for the rest of the walk).
        const snap = loadWalkSnapshot(walkId);
        if (snap && isNetworkError(e)) {
          setWalk(snap as unknown as Walks);
          setOfflineResumed(true);
          void pendingPoints().then((queued) =>
            setResumedPoints(queued.map((p) => ({ lat: p.lat, lng: p.lng }))),
          );
          return;
        }
        setError(e instanceof Error ? e.message : "walk not found");
      });
  }, [walkId, pendingPoints]);

  const [staticPoints, setStaticPoints] = useState<Array<{ lat: number; lng: number }>>([]);
  // Points saved before a mid-walk reload; prepended to live points for the
  // distance total and the route map.
  const [resumedPoints, setResumedPoints] = useState<Array<{ lat: number; lng: number }>>([]);

  // Broadcast every newly emitted point.
  useEffect(() => {
    if (!active) return;
    while (sentCount.current < geo.points.length) {
      const p = geo.points[sentCount.current];
      if (p) channel.sendPoint(p);
      sentCount.current += 1;
    }
  }, [geo.points, active, channel]);

  // Elapsed ticker.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  // Exit guard while in progress.
  useEffect(() => {
    if (!active) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [active]);

  const routePoints = useMemo(
    () => [...resumedPoints, ...geo.points],
    [resumedPoints, geo.points],
  );
  const distance = useMemo(() => pathDistanceM(routePoints), [routePoints]);

  async function start() {
    setBusy(true);
    try {
      const updated = await updateWalk(walkId, {
        status: "in_progress",
        started_at: new Date().toISOString(),
      });
      setWalk(updated);
      // Snapshot the in-progress walk locally so a mid-walk reload while
      // offline (dead zone) can re-enter recording mode without a network
      // getWalk — REST is network-only in the SW.
      saveWalkSnapshot(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not start walk");
    } finally {
      setBusy(false);
    }
  }

  async function addPhotos(files: FileList | null) {
    if (!files || !walk) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const compressed = await compressImage(file);
        const path = await uploadWalkPhoto(walk.operator_id, walk.id, compressed);
        setPhotoPaths((prev) => [...prev, path]);
        setPhotoPreviews((prev) => [...prev, URL.createObjectURL(compressed)]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "photo upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function endAndSend() {
    if (!walk) return;
    setBusy(true);
    setError(null);
    try {
      await channel.end(); // flush queued GPS inserts + announce ended
      const res = await completeWalk({
        walk_id: walk.id,
        ended_at: new Date().toISOString(),
        distance_m: distance,
        notes: notes.trim() || undefined,
        potty_pee: toggles.potty_pee,
        potty_poo: toggles.potty_poo,
        fed: toggles.fed,
        watered: toggles.watered,
        photo_paths: photoPaths,
      });
      setResult(res);
      setWalk(res.walk as unknown as Walks);
      setReportPhotoUrls(photoPreviews);
      clearWalkSnapshot(walkId); // walk is done; drop the offline-resume snapshot
    } catch (e) {
      setError(e instanceof Error ? e.message : "complete-walk failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !walk) {
    return (
      <div className="page">
        <Card>
          <EmptyState
            tone="attention"
            label="Needs attention"
            title="Couldn't open this walk"
            hint={error}
            action={<Button variant="ghost" onClick={() => navigate("/")}>Back to Today</Button>}
          />
        </Card>
      </div>
    );
  }
  if (!walk) {
    return (
      <div className="walkmode" style={{ minHeight: "100dvh", background: "var(--bg)" }}>
        <div className="page">
          <LoadingState label="Preparing walk mode" />
        </div>
      </div>
    );
  }

  const petNames = pets.map((p) => p.name).join(" & ");
  const reactive = pets.filter((p) => p.is_reactive || p.is_escape_risk);

  // ── completed: billing banner + report preview ─────────────────────────
  if (result) {
    const billing = result.billing;
    const paymentLabel = billing.payment_status
      ? paymentStatusTreatment(billing.payment_status).label
      : null;
    return (
      <div className="page">
        <span className="section-label">Walk complete</span>
        <h1>{petNames || "Report card"}</h1>
        <Card
          style={{
            marginTop: "var(--s-3)",
            background: billing.outcome === "overage"
              ? "var(--sanpo-color-surface-attention)"
              : "var(--sanpo-color-surface-success)",
            color: "var(--sanpo-color-text-primary)",
            borderColor: billing.outcome === "overage"
              ? "var(--sanpo-color-border-attention)"
              : "var(--sanpo-color-status-complete)",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: "var(--fs-20)" }} className="display">
            {billing.outcome === "debited"
              ? `Debited ${billing.cost_credits} credit${billing.cost_credits === 1 ? "" : "s"}`
              : `Overage — ${billing.charged_pence != null ? money(billing.charged_pence) : "charge pending"}`}
          </div>
          <div style={{ fontSize: "var(--fs-14)", marginTop: "var(--s-1)", opacity: 0.85 }}>
            {billing.outcome === "debited"
              ? "Fully covered by the credit balance."
              : `Whole walk charged at the plan overage rate${paymentLabel ? ` — ${paymentLabel}` : ""}.`}
          </div>
        </Card>
        <div style={{ marginTop: "var(--s-4)" }}>
          <ReportCard
            report={{
              photoUrls: reportPhotoUrls.filter(Boolean),
              routePoints: routePoints.length > 0 ? routePoints : staticPoints,
              distanceM: (result.walk as unknown as Walks).distance_m ?? distance,
              pottyPee: toggles.potty_pee || (walk.potty_pee ?? null),
              pottyPoo: toggles.potty_poo || (walk.potty_poo ?? null),
              fed: toggles.fed || (walk.fed ?? null),
              watered: toggles.watered || (walk.watered ?? null),
              notes: notes || walk.notes,
              petNames: pets.map((p) => p.name),
            }}
          />
        </div>
        <div style={{ marginTop: "var(--s-4)" }}>
          <Button full onClick={() => navigate("/")}>Back to Today</Button>
        </div>
      </div>
    );
  }

  // ── scheduled: start gate ────────────────────────────────────────────────
  if (walk.status === "scheduled") {
    return (
      <div className="walkmode" style={{ minHeight: "100dvh", background: "var(--bg)", color: "var(--text)" }}>
        <div className="page" style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
          <div>
            <span className="section-label">Ready to walk</span>
            <h1>{petNames || "Walk"}</h1>
            <p style={{ color: "var(--text-2)" }}>
              {walk.scheduled_date} · {time12(walk.window_start)}–{time12(walk.window_end)}
            </p>
          </div>
          {reactive.length > 0 && (
            <Card
              style={{
                background: "var(--sanpo-color-surface-attention)",
                borderColor: "var(--sanpo-color-border-attention)",
                color: "var(--sanpo-color-text-primary)",
              }}
            >
              {reactive.map((p) => (
                <div key={p.id} style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
                  <Badge status="attention">{p.is_reactive ? "Reactive" : "Escape risk"}</Badge>
                  <span>{p.name}</span>
                </div>
              ))}
            </Card>
          )}
          <Button full onClick={() => void start()} disabled={busy}>
            {busy ? <Spinner /> : "Start walk"}
          </Button>
          {error && <span className="field__error">{error}</span>}
        </div>
      </div>
    );
  }

  if (walk.status !== "in_progress") {
    const treatment = walkStatusTreatment(walk.status, walk.is_overage);
    return (
      <div className="page">
        <Card><EmptyState title={`Walk is ${treatment.label.toLowerCase()}`} /></Card>
      </div>
    );
  }

  // ── in progress ──────────────────────────────────────────────────────────
  return (
    <div className="walkmode" style={{ minHeight: "100dvh", background: "var(--bg)", color: "var(--text)" }}>
      <div className="page" style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", paddingBottom: "var(--s-8)" }}>
        <div className={`walk-live-state${online ? "" : " walk-live-state--offline"}`}>
          <span className={`walk-live-state__label${online ? "" : " walk-live-state__label--offline"}`}>
            {online ? "CURRENT" : "OFFLINE"}
          </span>
          <span className="walk-live-state__pet">{petNames || "Walking"}</span>
          {!online && (
            <span className="walk-live-state__detail">
              {offlineResumed
                ? "Walk resumed offline. Route points are saved on this device and will sync when the connection returns."
                : "Route points are saved on this device and will sync when the connection returns."}
            </span>
          )}
        </div>

        <div className="walk-metrics">
          <span className="numeral" style={{ fontSize: "var(--fs-44)", fontWeight: 700 }}>
            {walk.started_at ? elapsed(walk.started_at, now) : "00:00"}
          </span>
          <span className="numeral" style={{ fontSize: "var(--fs-32)", color: "var(--sanpo-color-text-link)" }}>
            {distanceKm(distance)}
          </span>
        </div>

        <MapView points={routePoints} live />
        {geo.error && (
          <StateField
            compact
            tone="attention"
            label="Location unavailable"
            title="The route isn't being recorded"
            detail={`${geo.error}${geo.permission === "denied" ? " Enable location access to record the route." : ""}`}
            role="alert"
          />
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-2)" }}>
          {(
            [
              ["potty_pee", "Pee"],
              ["potty_poo", "Poo"],
              ["fed", "Fed"],
              ["watered", "Water"],
            ] as const
          ).map(([key, label]) => (
            <button
              type="button"
              key={key}
              className="choice-button"
              aria-pressed={toggles[key]}
              onClick={() => setToggles((t) => ({ ...t, [key]: !t[key] }))}
            >
              {toggles[key] ? "✓ " : ""}{label}
            </button>
          ))}
        </div>

        <label className="field">
          <span className="field__label">Photos</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={(e) => void addPhotos(e.target.files)}
            disabled={uploading}
          />
        </label>
        {photoPreviews.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--s-2)" }}>
            {photoPreviews.map((url) => (
              <img key={url} src={url} alt="Walk photo" style={{ aspectRatio: "1", objectFit: "cover", borderRadius: "var(--r-sm)", width: "100%" }} />
            ))}
          </div>
        )}

        <Textarea
          label="Notes for the report card"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="How did it go?"
        />

        {error && <span className="field__error">{error}</span>}
        <Button full onClick={() => void endAndSend()} disabled={busy || uploading}>
          {busy ? <Spinner /> : "End walk & send report"}
        </Button>
        <p style={{ color: "var(--text-2)", fontSize: "var(--fs-12)", textAlign: "center" }}>
          Keep this screen open during the walk — leaving pauses GPS recording.
        </p>
      </div>
    </div>
  );
}
