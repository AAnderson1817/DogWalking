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
import { FormError, Textarea } from "@/components/fields";
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
  insertWalkPhoto,
  listServiceTypes,
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
import { useWakeLock } from "@/hooks/useWakeLock";
import { useWalkChannel } from "@/hooks/useWalkChannel";
import { GPS_GAP_MS, pathDistanceM } from "@/lib/geo";
import { distanceMi, elapsed, money, time12 } from "@/lib/format";
import { compressImage } from "@/lib/image";
import {
  clearWalkSnapshot,
  isNetworkError,
  loadWalkSnapshot,
  mergeResumedPhotos,
  readWalkProgress,
  resumeNotes,
  saveWalkSnapshot,
  shouldPersistProgress,
} from "@/lib/walk-snapshot";
import { walkSessionBound } from "@/lib/walk-session";
import type { Pets, Walks } from "@/lib/types";
import { useDocumentTitle } from "@/lib/use-document-title";
import { ApprovedIcon } from "@/components/ApprovedIcon";

/** A trail point read back from the DB or the outbox, gap mark included. */
interface ResumedPoint {
  lat: number;
  lng: number;
  gapBefore?: boolean;
}

export default function WalkMode() {
  useDocumentTitle("Walk in progress");
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
  // The booked length of THIS walk's service, so the overrun bound scales with
  // it (review M28). Null until loaded, and permanently null on the offline
  // resume path, which has no way to read `service_types` — `walkSessionBound`
  // owns what that means.
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  // Epoch ms of the operator's last "still walking". Deliberately NOT
  // persisted: a snooze is an answer to a question asked on this screen, and
  // restoring one from before a reload would silence the prompt for a walk
  // nobody has looked at since.
  const [snoozedAt, setSnoozedAt] = useState<number | null>(null);
  // Until the initial load has put photos/toggles/notes back, the snapshot
  // writer below must not run — it would persist this component's empty
  // starting state over the very record it is about to read. State rather than
  // a ref so setting it re-runs that effect.
  const [hydrated, setHydrated] = useState(false);

  const active = walk?.status === "in_progress" && !result;

  // Review M28. A walk had no time bound at all, so a forgotten END WALK kept
  // recording for as long as the app stayed open and the route grew while the
  // operator drove home — on the distance sold to the client as proof of
  // service. `prompting` asks; `capped` stops emitting, and only after the
  // question has gone unanswered. Neither completes the walk: completing means
  // billing, and a duration invented by a timer is not something to charge for.
  const session = walkSessionBound({
    startedAt: walk?.started_at ?? null,
    durationMinutes,
    now,
    snoozedAt,
  });
  const overrunPrompt = (active && session?.prompting) ?? false;
  const recording = active === true && session?.capped !== true;

  const geo = useGeolocation(recording);
  // Best effort against the OS suspending the watch when the screen locks.
  // Released with recording: holding the screen awake for a walk nobody is
  // answering for is the battery cost with none of the benefit.
  const wakeLock = useWakeLock(recording);
  const channel = useWalkChannel(walkId, "broadcast", auth.operatorId ?? "");
  const pendingPoints = channel.pendingPoints;
  const online = useOnline();
  // Review M7. "Is anything still waiting?" rather than "does the OS think we
  // have a network?" — `navigator.onLine` is true on a captive portal and on
  // one bar with no throughput, which is exactly when batches pile up.
  const pendingBatches = channel.outboxStatus.pending;
  const lostPoints = channel.outboxStatus.lostPoints;
  const synced = online && pendingBatches === 0;
  const sentCount = useRef(0);

  useEffect(() => {
    void getWalk(walkId)
      .then(async (w) => {
        setWalk(w);
        setPets(await listWalkPets(walkId));
        // Tolerated failure: without it the overrun bound falls back to a
        // fixed duration, which is a slightly blunter prompt — not a reason to
        // fail the screen an operator is standing on a doorstep holding.
        void listServiceTypes()
          .then((types) =>
            setDurationMinutes(
              types.find((t) => t.id === w.service_type_id)?.duration_minutes ?? null,
            ),
          )
          .catch(() => setDurationMinutes(null));
        setNotes(w.notes ?? "");
        // Resuming an in-progress walk after a reload: seed the route and
        // distance baseline from points already saved AND any still queued in
        // the offline outbox, so the report doesn't silently lose everything
        // walked before the reload (especially after an offline stretch, when
        // most of the trail is still in the outbox, not the DB yet).
        if (w.status === "in_progress") {
          const [saved, queued, photos] = await Promise.all([
            listWalkGpsPoints(walkId),
            pendingPoints(),
            // Photos are durable from the moment they upload (review H8), so
            // the server is the primary source here — this survives a reload
            // on a different device, which localStorage cannot.
            listWalkPhotos(walkId).catch(() => []),
          ]);
          const seen = new Set<string>();
          const merged: ResumedPoint[] = [];
          const before = [
            // `gap_before` (0027) rides along, so a walk resumed after a screen
            // lock still shows the break and still excludes it from distance.
            ...saved.map((x) => ({ lat: x.lat, lng: x.lng, gapBefore: x.gap_before })),
            ...queued.map((p) => ({ lat: p.lat, lng: p.lng, gapBefore: p.gapBefore })),
          ];
          for (const p of before) {
            const key = `${p.lat},${p.lng}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // The first point of the trail cannot carry a gap: there is no
            // preceding segment for it to break.
            const isGap = p.gapBefore === true && merged.length > 0;
            merged.push({ lat: p.lat, lng: p.lng, ...(isGap ? { gapBefore: true } : {}) });
          }
          setResumedPoints(merged);

          // Care toggles and notes have no column until completion, so the
          // local snapshot is the only place they exist. Photos union the two:
          // a photo uploaded while offline reached Storage but its row insert
          // did not, and dropping it would strand the file in the bucket.
          const progress = readWalkProgress(loadWalkSnapshot(walkId));
          const paths = mergeResumedPhotos(photos.map((p) => p.storage_path), progress.photo_paths);
          setToggles(progress.toggles);
          setNotes(resumeNotes(progress.notes, w.notes));
          setPhotoPaths(paths);
          if (paths.length > 0) {
            setPhotoPreviews(
              await Promise.all(paths.map((p) => signedPhotoUrl(p).catch(() => ""))),
            );
          }
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
          setStaticPoints(points.map((p, i) => ({
            lat: p.lat,
            lng: p.lng,
            // Same rule as the resume path: the first point has nothing behind
            // it to break away from.
            ...(p.gap_before && i > 0 ? { gapBefore: true } : {}),
          })));
        }
        setHydrated(true);
      })
      .catch((e: unknown) => {
        // Offline mid-walk reload: the SW keeps REST network-only, so getWalk
        // fails. Fall back to the local snapshot to keep recording rather than
        // dead-ending (which would stop GPS for the rest of the walk).
        const snap = loadWalkSnapshot(walkId);
        if (snap && isNetworkError(e)) {
          const progress = readWalkProgress(snap);
          setWalk(snap as unknown as Walks);
          setOfflineResumed(true);
          // No server to ask, so the snapshot is everything. Photo previews
          // stay empty — signing a URL needs the network too — but the paths
          // are carried, so completing the walk still records every photo.
          setToggles(progress.toggles);
          setNotes(progress.notes);
          setPhotoPaths(progress.photo_paths);
          setHydrated(true);
          void pendingPoints().then((queued) =>
            setResumedPoints(queued.map((p) => ({ lat: p.lat, lng: p.lng }))),
          );
          return;
        }
        setError(e instanceof Error ? e.message : "walk not found");
      });
  }, [walkId, pendingPoints]);

  // Persist progress on every change, once the load above has put back what
  // was already there. Photos are durable server-side from upload; this is the
  // only home the toggles and notes have until the walk completes, and the
  // fallback for a photo whose row insert was offline.
  useEffect(() => {
    if (!walk) return;
    if (!shouldPersistProgress({ hydrated, status: walk.status, completed: !!result })) return;
    saveWalkSnapshot(walk, { photo_paths: photoPaths, toggles, notes });
  }, [hydrated, walk, photoPaths, toggles, notes, result]);

  const [staticPoints, setStaticPoints] = useState<ResumedPoint[]>([]);
  // Points saved before a mid-walk reload; prepended to live points for the
  // distance total and the route map.
  const [resumedPoints, setResumedPoints] = useState<ResumedPoint[]>([]);

  // Broadcast every newly emitted point.
  useEffect(() => {
    if (!recording) return;
    while (sentCount.current < geo.points.length) {
      const p = geo.points[sentCount.current];
      if (p) channel.sendPoint(p);
      sentCount.current += 1;
    }
  }, [geo.points, recording, channel]);

  // Elapsed ticker.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  // Exit guard while in progress — reload, tab close, app switch.
  useEffect(() => {
    if (!active) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [active]);

  // …and the other way out, which `beforeunload` does not cover: the browser
  // back button or an edge-swipe back gesture. That is a same-document history
  // navigation, so no unload fires — Walk Mode simply unmounted and recording
  // stopped, with no confirmation at all (review H8).
  //
  // A sentinel entry rather than react-router's `useBlocker`, which needs a
  // data router (`createBrowserRouter`); this app mounts `<BrowserRouter>`, and
  // migrating the whole router to add one prompt would be a far larger change
  // than the bug warrants. The sentinel is the same URL, so popping it
  // re-renders this route instead of unmounting it, and the confirm happens
  // while the walk is still on screen and still recording.
  useEffect(() => {
    if (!active) return;
    const sentinel = { sanpoWalkGuard: walkId };
    window.history.pushState(sentinel, "");
    const onPop = () => {
      const leave = window.confirm(
        "This walk is still recording. Leave now and GPS recording stops — the walk stays in progress.",
      );
      if (leave) {
        // The sentinel is already gone; one more step actually leaves.
        window.history.back();
      } else {
        window.history.pushState(sentinel, "");
      }
    };
    window.addEventListener("popstate", onPop);
    // The sentinel entry is deliberately left behind on a normal end-of-walk
    // exit. It points at this same URL, so the only effect is that Back from
    // the report card shows the report card once more; calling history.back()
    // from a cleanup would race whatever navigation triggered the cleanup.
    return () => window.removeEventListener("popstate", onPop);
  }, [active, walkId]);

  // Object URLs for the photo strip are never revoked otherwise, and the
  // memory pressure that causes is one of the things that gets a tab reclaimed
  // mid-walk — the exact event the rest of this file is defending against.
  const previewsRef = useRef<string[]>([]);
  useEffect(() => {
    previewsRef.current = photoPreviews;
  }, [photoPreviews]);
  useEffect(() => () => {
    for (const url of previewsRef.current) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    }
  }, []);

  const routePoints = useMemo(() => {
    // The remount itself is a gap: the walk carried on while the page was
    // reloading and nothing was watching. Marking the join breaks the line
    // there and leaves that stretch out of the distance, which under-reports
    // rather than inventing a straight line across it — the safe direction for
    // a number printed on the client's report card as proof of service.
    const [first, ...rest] = geo.points;
    if (resumedPoints.length === 0 || !first) return [...resumedPoints, ...geo.points];
    return [...resumedPoints, { ...first, gapBefore: true }, ...rest];
  }, [resumedPoints, geo.points]);
  const distance = useMemo(() => pathDistanceM(routePoints), [routePoints]);

  // `now` already ticks once a second for the elapsed timer, so staleness is
  // free. Before the first fix there is nothing to be stale about — that is
  // the ordinary "acquiring GPS" moment, not a suspension.
  // `recording`, not `active`: once the overrun cap has stopped emission the
  // fixes stop too, and "Recording paused — reopen this screen to resume"
  // would be the wrong explanation for a stop the product chose on purpose.
  const gpsStalled = recording && geo.lastFixAt != null && now - geo.lastFixAt > GPS_GAP_MS;

  async function start() {
    setBusy(true);
    try {
      const updated = await updateWalk(walkId, {
        status: "in_progress",
        started_at: new Date().toISOString(),
      });
      setWalk(updated);
      // The snapshot is written by the effect above, not here. One writer:
      // a second call site would have to remember to pass the current progress
      // and, passing none, would silently erase the photos, toggles and notes
      // it did not know about.
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
        // Record the row now rather than at completion (review H8): until this
        // existed, the only pointer to an uploaded photo was React state, so a
        // remount stranded every photo in the bucket with nothing referencing
        // it. Best-effort because the upload has already succeeded — offline,
        // the path is still held in state and the snapshot, and complete-walk
        // writes the row with the same conflict target.
        try {
          await insertWalkPhoto(walk.operator_id, walk.id, path);
        } catch {
          // no-op: the photo is in Storage and the path is carried forward.
        }
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
          <FormError message={error} />
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
        {/* Review M7. The label used to be driven purely by `navigator.onLine`,
            which is true on a captive portal and on one bar with no
            throughput — so a walk whose route points were piling up unsent
            read "CURRENT", identical to one syncing perfectly. `synced` is
            the honest question: is anything still waiting? */}
        <div className={`walk-live-state${synced ? "" : " walk-live-state--offline"}`}>
          <span className={`walk-live-state__label${synced ? "" : " walk-live-state__label--offline"}`}>
            {synced ? "CURRENT" : online ? "SAVING" : "OFFLINE"}
          </span>
          <span className="walk-live-state__pet">{petNames || "Walking"}</span>
          {!synced && (
            <span className="walk-live-state__detail">
              {!online && offlineResumed
                ? "Walk resumed offline. Route points are saved on this device and will sync when the connection returns."
                : !online
                  ? "Route points are saved on this device and will sync when the connection returns."
                  : `${pendingBatches} route update${pendingBatches === 1 ? "" : "s"} still saving. `
                    + "They are stored on this device until they reach the server."}
            </span>
          )}
        </div>

        {/* The batches the server refused often enough that we stopped
            trying. Before M7 these were deleted outright — no log, no
            counter, no flag — so the route quietly lost a stretch and the
            distance under-reported with nothing anywhere saying so. Now
            they are kept, counted, and said out loud. */}
        {lostPoints > 0 && (
          <StateField
            compact
            tone="attention"
            label="Route incomplete"
            title={`${lostPoints} location update${lostPoints === 1 ? "" : "s"} could not be saved`}
            detail={
              "They stay on this device, but they are not in the walk record — the route "
              + "and the distance on the report leave that stretch out rather than guessing across it."
            }
            role="status"
          />
        )}

        {/* Both figures were bare spans with no label of any kind, visual or
            accessible — "12:34" and "1.2 km" with nothing saying which is
            which. Elapsed time is the number that decides whether the
            service about to be billed was delivered, so it is named, given
            role="timer", and marked aria-live="off": it re-renders every
            second and would otherwise interrupt continuously. */}
        <div className="walk-metrics">
          <span
            className="numeral"
            style={{ fontSize: "var(--fs-44)", fontWeight: 700 }}
            role="timer"
            aria-live="off"
            aria-label={`Elapsed walk time ${walk.started_at ? elapsed(walk.started_at, now) : "00:00"}`}
          >
            {walk.started_at ? elapsed(walk.started_at, now) : "00:00"}
          </span>
          <span
            className="numeral"
            style={{ fontSize: "var(--fs-32)", color: "var(--sanpo-color-text-link)" }}
            aria-label={`Distance walked ${distanceMi(distance)}`}
          >
            {distanceMi(distance)}
          </span>
        </div>

        <MapView points={routePoints} live />

        {/* Review M28. First, and above the GPS banners, because it is the
            only one asking the operator a question. */}
        {overrunPrompt && !session?.capped && (
          <StateField
            compact
            tone="attention"
            label="Still walking?"
            title={`This walk has been running for ${walk.started_at ? elapsed(walk.started_at, now) : "a while"}`}
            detail={
              "If it's finished, end it now so the client gets their report and it's "
              + "billed. If you're still out, say so and recording carries on."
            }
            role="status"
            action={
              <Button variant="ghost" onClick={() => setSnoozedAt(Date.now())}>
                Yes, still walking
              </Button>
            }
          />
        )}

        {session?.capped && active && (
          <StateField
            compact
            tone="attention"
            label="Recording stopped"
            title="GPS recording has stopped for this walk"
            detail={
              "Nobody answered, so the route stops where the evidence for it does — "
              + "everything recorded up to that point is kept. End the walk to send the "
              + "report, or resume if you're still out."
            }
            role="status"
            action={
              <Button variant="ghost" onClick={() => setSnoozedAt(Date.now())}>
                Resume recording
              </Button>
            }
          />
        )}

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
        {/* A suspended watch raises no error, so without this the screen looks
            identical whether or not the route is still being recorded — the
            one thing the operator most needs to know. `geo.error` takes
            precedence: a denied permission is a different problem with a
            different fix, and showing both would be noise. */}
        {!geo.error && gpsStalled && (
          <StateField
            compact
            tone="attention"
            label="Recording paused"
            title="No location fix for a while"
            detail={
              "The phone may have locked or switched apps. Reopen this screen to resume — "
              + "the walk keeps running, and the stretch that wasn't recorded is left out "
              + "of the route and the distance rather than guessed."
            }
            role="status"
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
              {toggles[key] && <ApprovedIcon name="check" size={14} />}{label}
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

        <FormError message={error} />
        <Button full onClick={() => void endAndSend()} disabled={busy || uploading}>
          {busy ? <Spinner /> : "End walk & send report"}
        </Button>
        {/* The old copy ("keep this screen open") was the product's ENTIRE
            mitigation for a suspended watch, and it asked for something the
            operator cannot do with a phone in a pocket. Now the wake lock does
            the work where the browser supports it, and where it does not the
            hint says so plainly instead of implying the recording is fine. */}
        <p style={{ color: "var(--text-2)", fontSize: "var(--fs-12)", textAlign: "center" }}>
          {wakeLock.held
            ? "The screen is being kept awake for this walk."
            : wakeLock.supported
            ? "Keep this screen open — GPS stops recording when the phone locks."
            : "This browser can't keep the screen awake. Keep the phone unlocked "
              + "with this screen open, or GPS stops recording."}
        </p>
      </div>
    </div>
  );
}
