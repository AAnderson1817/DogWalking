// Review H5: the operator's export and erasure controls.
//
// Before this there was no product path for either. A deletion or portability
// request could not be honoured at all — the honest answer to "describe your
// data deletion process" was "there is no process".
//
// Export comes first, deliberately: an operator asked to delete a client should
// be able to hand them their record on the way out.
import { useEffect, useState } from "react";
import { Button } from "./Button";
import { FormError, Input } from "./fields";
import { Sheet } from "./Sheet";
import { exportClientData, getErasureStatus, purgeClient,
  type ClientRecord, type ErasureStatus,
} from "@/lib/api";

/** Typed to confirm. Not a yes/no — this destroys a person's record. */
const CONFIRM_WORD = "DELETE";

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
  // What the database says about an erasure that has begun (0058). The first
  // phase marks the client erased before any photo is deleted, so `purged_at`
  // alone cannot say the erasure finished — this screen used to read it that
  // way, hide the button, and leave the rest waiting for a retry nobody could
  // start.
  const [status, setStatus] = useState<ErasureStatus | "unknown" | null>(null);

  const purged = client.purged_at !== null;

  useEffect(() => {
    if (!purged) {
      setStatus(null);
      return;
    }
    let live = true;
    getErasureStatus(client.id).then(
      (s) => { if (live) setStatus(s); },
      () => { if (live) setStatus("unknown"); },
    );
    return () => {
      live = false;
    };
  }, [client.id, purged]);

  const unfinished = purged && status !== null && (status === "unknown" || !status.finished);

  async function download() {
    setError(null);
    try {
      const bundle = await exportClientData(client.id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sanpo-${client.full_name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`;
      a.click();
      // Revoked on the next tick rather than immediately: revoking before the
      // browser has started the download cancels it.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    }
  }

  async function erase() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await purgeClient(client.id);
      setStatus({ erased: true, finished: result.finished, photosLeft: result.photosLeft });
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
          Give this client a copy of their records, or erase them. The copy
          holds their details, address, pets, visits and billing, and leaves
          out route traces, photos and the entry-code log. Erasure removes
          their address, entry codes, pet notes, route traces and photos. The
          billing ledger is kept — it is a financial record.
        </p>
      )}

      <FormError message={error} />
      {notice && <p className="client-data-panel__detail" role="status">{notice}</p>}

      <div className="client-data-panel__actions">
        <Button variant="ghost" onClick={() => void download()}>
          Export their data
        </Button>
        {!purged && (
          <Button variant="ghost" onClick={() => setOpen(true)}>
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
            disabled={typed !== CONFIRM_WORD || busy}
            onClick={() => void erase()}
          >
            {busy ? "Erasing…" : "Erase permanently"}
          </Button>
        </div>
      </Sheet>
    </section>
  );
}
