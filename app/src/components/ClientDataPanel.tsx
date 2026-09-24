// Review H5: the operator's export and erasure controls.
//
// Before this there was no product path for either. A deletion or portability
// request could not be honoured at all — the honest answer to "describe your
// data deletion process" was "there is no process".
//
// Export comes first, deliberately: an operator asked to delete a client should
// be able to hand them their record on the way out.
import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { FormError, Input } from "./fields";
import { Sheet } from "./Sheet";
import { downloadPhoto, exportClientData, exportClientRoutes, getErasureStatus, purgeClient,
  type ClientRecord, type ErasureStatus,
} from "@/lib/api";
import {
  buildClientExport, ExportCancelled, exportProgressCount, exportProgressText, type ExportProgress,
} from "@/lib/client-export";

/** Typed to confirm. Not a yes/no — this destroys a person's record. */
const CONFIRM_WORD = "DELETE";

/** Hand the browser a file to save. */
function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoked on the next tick rather than immediately: revoking before the
  // browser has started the download cancels it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ClientDataPanel({
  client,
  onPurged,
}: {
  client: ClientRecord;
  onPurged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The copy being made, if one is, and how far it has got. The controller
  // is what Cancel aborts, and what leaving the screen aborts too: a copy the
  // walker can no longer see finishing should not arrive as a download later.
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const run = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = run;
    return () => current.current?.abort();
  }, []);
  const exporting = progress !== null;
  // What the database says about an erasure that has begun (0058). The first
  // phase marks the client erased before any photo is deleted, so `purged_at`
  // alone cannot say the erasure finished — this screen used to read it that
  // way, hide the button, and leave the rest waiting for a retry nobody could
  // start. The answer is kept with the client it is about: this panel can be
  // handed another client while a request for the last one is in flight, and
  // one client's "finished" must never stand for another's.
  const [answer, setAnswer] = useState<{ client: string; value: ErasureStatus | "unknown" } | null>(null);
  const status = answer?.client === client.id ? answer.value : null;

  const purged = client.purged_at !== null;

  useEffect(() => {
    if (!purged) return;
    let live = true;
    const about = client.id;
    getErasureStatus(about).then(
      (s) => { if (live) setAnswer({ client: about, value: s }); },
      () => { if (live) setAnswer({ client: about, value: "unknown" }); },
    );
    return () => {
      live = false;
    };
  }, [client.id, purged]);

  const unfinished = purged && status !== null && (status === "unknown" || !status.finished);

  // The copy (0059): the record, every route in batches, and every photo
  // Storage holds for the client, packed into one ZIP in the browser. Not
  // offered once the client is erased: the database refuses it, because
  // what is left then is being destroyed or kept only as the walker's
  // financial record.
  async function download() {
    const controller = new AbortController();
    run.current = controller;
    setError(null);
    setNotice(null);
    setProgress({ stage: "record", done: 0, total: 1 });
    try {
      const out = await buildClientExport(client.id, {
        record: exportClientData,
        routes: exportClientRoutes,
        download: downloadPhoto,
        now: () => new Date(),
        progress: (p) => { if (!controller.signal.aborted) setProgress(p); },
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new ExportCancelled("The copy was cancelled.");
      saveFile(out.blob, out.fileName);
      setNotice(
        out.photosMissing > 0
          ? `The copy is ready. ${out.photosMissing} photo(s) could not be fetched; the copy marks each one as missing, and a new copy can try again.`
          : "The copy is ready.",
      );
    } catch (err) {
      if (err instanceof ExportCancelled) setNotice("The copy was cancelled. Nothing was saved.");
      else setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      if (run.current === controller) run.current = null;
      setProgress(null);
    }
  }

  async function erase() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const about = client.id;
      const result = await purgeClient(about);
      setAnswer({ client: about, value: { erased: true, finished: result.finished, photosLeft: result.photosLeft } });
      if (result.finished) setNotice("This client's personal data has been erased.");
      setOpen(false);
      setTyped("");
    } catch (err) {
      // The first phase may have committed before the failure, so the record
      // is reloaded either way and the panel shows what the database says.
      setError(err instanceof Error ? err.message : "Erasure failed.");
    } finally {
      setBusy(false);
      onPurged();
    }
  }

  return (
    <section className="client-data-panel" aria-labelledby="client-data-heading">
      <h2 id="client-data-heading" className="section-label">Their data</h2>

      {purged && status === null ? (
        <p className="client-data-panel__detail">Checking whether erasing this client's data finished…</p>
      ) : unfinished ? (
        <p className="client-data-panel__detail">
          {status === "unknown"
            ? "This client's record was erased, but whether every photo is gone could not be checked."
            : status.photosLeft > 0
              ? `Erasing this client's data has not finished: ${status.photosLeft} photo(s) are still stored. Everything else is erased.`
              : "Erasing this client's data has not finished: its last step did not run. Everything else is erased."}
        </p>
      ) : purged ? (
        <p className="client-data-panel__detail">
          This client's personal data was erased. The billing record remains,
          because it is a financial record.
        </p>
      ) : (
        <p className="client-data-panel__detail">
          Give this client a copy of their records, or erase them. The copy is
          a ZIP file of what Sanpo holds about them that you can see: their
          details, addresses, pets and schedules, each visit with its route
          and photos, the entry-code log, credits and payments. It lists what
          it leaves out, and why. Make it before erasing: once their data is
          erased, a copy can no longer be made. Erasure removes their address,
          entry codes, pet notes, route traces and photos. The billing ledger
          is kept — it is a financial record.
        </p>
      )}

      <FormError message={error} />
      {/* Always mounted: a live region that arrives with its text is announced
          far less reliably than one whose text changes. It changes only with
          the stage; the count below it is on screen but not announced. */}
      <p className="client-data-panel__detail" role="status">
        {progress ? exportProgressText(progress) : (notice ?? "")}
      </p>
      {progress && exportProgressCount(progress) && (
        <p className="client-data-panel__detail">{exportProgressCount(progress)}</p>
      )}

      <div className="client-data-panel__actions">
        {!purged && (
          <Button variant="ghost" disabled={exporting || busy} onClick={() => void download()}>
            {exporting ? "Making the copy…" : "Export their data"}
          </Button>
        )}
        {exporting && (
          <Button variant="ghost" onClick={() => run.current?.abort()}>
            Cancel the copy
          </Button>
        )}
        {!purged && (
          <Button variant="ghost" disabled={exporting} onClick={() => setOpen(true)}>
            Erase their data
          </Button>
        )}
        {unfinished && (
          <Button variant="ghost" disabled={busy} onClick={() => void erase()}>
            {busy ? "Erasing…" : "Finish erasing"}
          </Button>
        )}
      </div>

      <Sheet open={open} onClose={() => setOpen(false)} title="Erase this client's data">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          <p className="client-data-panel__detail">
            This permanently destroys {client.full_name}'s address, entry codes,
            pet medical notes, every route trace and every photo. It cannot be
            undone. Export first if they asked for a copy.
          </p>
          <Input
            label={`Type ${CONFIRM_WORD} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <FormError message={error} />
          <Button
            full
            disabled={typed !== CONFIRM_WORD || busy || exporting}
            onClick={() => void erase()}
          >
            {busy ? "Erasing…" : "Erase permanently"}
          </Button>
        </div>
      </Sheet>
    </section>
  );
}
