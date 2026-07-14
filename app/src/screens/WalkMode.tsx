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
import { distanceKm, elapsed, money } from "@/lib/format";
import { compressImage } from "@/lib/image";
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
  const [now, setNow] = useState(() => Date.now());

  const active = walk?.status === "in_progress" && !result;
  const geo = useGeolocation(active ?? false);
  const channel = useWalkChannel(walkId, "broadcast", auth.operatorId ?? "");
  const online = useOnline();
  const sentCount = useRef(0);

  useEffect(() => {
    void getWalk(walkId)
      .then(async (w) => {
        setWalk(w);
        setPets(await listWalkPets(walkId));
        setNotes(w.notes ?? "");
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
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "walk not found"));
  }, [walkId]);

  const [staticPoints, setStaticPoints] = useState<Array<{ lat: number; lng: number }>>([]);

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

  const distance = useMemo(() => pathDistanceM(geo.points), [geo.points]);

  async function start() {
    setBusy(true);
    try {
      const updated = await updateWalk(walkId, {
        status: "in_progress",
        started_at: new Date().toISOString(),
      });
      setWalk(updated);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "complete-walk failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !walk) {
    return (
      <div className="page">
        <Card><EmptyState title="Walk not found" hint={error} /></Card>
      </div>
    );
  }
  if (!walk) {
    return (
      <div className="walkmode" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
        <Spinner />
      </div>
    );
  }

  const petNames = pets.map((p) => p.name).join(" & ");
  const reactive = pets.filter((p) => p.is_reactive || p.is_escape_risk);

  // ── completed: billing banner + report preview ─────────────────────────
  if (result) {
    const billing = result.billing;
    return (
      <div className="page">
        <span className="section-label">Walk complete</span>
        <h1>{petNames || "Report card"}</h1>
        <Card
          style={{
            marginTop: "var(--s-3)",
            background: billing.outcome === "overage" ? "var(--butter)" : "var(--mint)",
            color: billing.outcome === "overage" ? "var(--butter-ink)" : "var(--mint-ink)",
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
              : `Whole walk charged at the plan overage rate${billing.payment_status ? ` (${billing.payment_status})` : ""}.`}
          </div>
        </Card>
        <div style={{ marginTop: "var(--s-4)" }}>
          <ReportCard
            report={{
              photoUrls: reportPhotoUrls.filter(Boolean),
              routePoints: geo.points.length > 0 ? geo.points : staticPoints,
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
              {walk.scheduled_date} · {walk.window_start.slice(0, 5)}–{walk.window_end.slice(0, 5)}
            </p>
          </div>
          {reactive.length > 0 && (
            <Card style={{ background: "var(--pink)" }}>
              {reactive.map((p) => (
                <div key={p.id} style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
                  <Badge status="warn">{p.is_reactive ? "Reactive" : "Escape risk"}</Badge>
                  <span>{p.name}</span>
                </div>
              ))}
            </Card>
          )}
          <Button variant="accent" full onClick={() => void start()} disabled={busy}>
            {busy ? <Spinner /> : "Start walk"}
          </Button>
          {error && <span className="field__error">{error}</span>}
        </div>
      </div>
    );
  }

  if (walk.status !== "in_progress") {
    return (
      <div className="page">
        <Card><EmptyState title={`Walk is ${walk.status}`} /></Card>
      </div>
    );
  }

  // ── in progress ──────────────────────────────────────────────────────────
  return (
    <div className="walkmode" style={{ minHeight: "100dvh", background: "var(--bg)", color: "var(--text)" }}>
      <div className="page" style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", paddingBottom: "var(--s-8)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
          {online ? (
            <span className="pulse-live" aria-hidden />
          ) : (
            <span
              aria-label="offline"
              style={{
                width: 10,
                height: 10,
                borderRadius: "var(--r-full)",
                background: "var(--ink-faint)",
                flexShrink: 0,
              }}
            />
          )}
          <span style={{ fontWeight: 600 }}>{petNames || "Walking"}</span>
          {!online && (
            <span style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
              offline — points queued, they'll sync on reconnect
            </span>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="numeral" style={{ fontSize: "var(--fs-44)", fontWeight: 700 }}>
            {walk.started_at ? elapsed(walk.started_at, now) : "00:00"}
          </span>
          <span className="numeral" style={{ fontSize: "var(--fs-32)", color: "var(--sky-mid)" }}>
            {distanceKm(distance)}
          </span>
        </div>

        <MapView points={geo.points} live />
        {geo.error && (
          <p style={{ color: "var(--orange-deep)", fontSize: "var(--fs-14)", fontWeight: 800 }}>
            GPS: {geo.error} {geo.permission === "denied" ? "— enable location access to record the route." : ""}
          </p>
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
            <Button
              key={key}
              variant={toggles[key] ? "accent" : "ghost"}
              onClick={() => setToggles((t) => ({ ...t, [key]: !t[key] }))}
            >
              {toggles[key] ? "✓ " : ""}{label}
            </Button>
          ))}
        </div>

        <label className="field">
          <span className="field__label" style={{ color: "var(--text-2)" }}>Photos</span>
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
        <Button variant="accent" full onClick={() => void endAndSend()} disabled={busy || uploading}>
          {busy ? <Spinner /> : "End walk & send report"}
        </Button>
        <p style={{ color: "var(--text-2)", fontSize: "var(--fs-12)", textAlign: "center" }}>
          Keep this screen open during the walk — leaving pauses GPS recording.
        </p>
      </div>
    </div>
  );
}
