// Review H5: the operator's export and erasure controls.
//
// Before this there was no product path for either. A deletion or portability
// request could not be honoured at all — the honest answer to "describe your
// data deletion process" was "there is no process".
//
// Export comes first, deliberately: an operator asked to delete a client should
// be able to hand them their record on the way out.
import { useState } from "react";
import { Button } from "./Button";
import { FormError, Input } from "./fields";
import { Sheet } from "./Sheet";
import { exportClientData, purgeClient,
  type ClientRecord,
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

  const purged = client.purged_at !== null;

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
    try {
      const result = await purgeClient(client.id);
      if (result.failedPaths.length > 0) {
        // Reporting success over a photo that is still in the bucket is the
        // one outcome that would make this worse than doing nothing.
        setError(
          `${result.failedPaths.length} photo(s) could not be deleted, so the erasure is incomplete. Everything else is gone. Try again — it picks up where it stopped.`,
        );
        return;
      }
      setNotice("This client's personal data has been erased.");
      setOpen(false);
      setTyped("");
      onPurged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erasure failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="client-data-panel" aria-labelledby="client-data-heading">
      <h2 id="client-data-heading" className="section-label">Their data</h2>

      {purged ? (
        <p className="client-data-panel__detail">
          This client's personal data was erased. The billing record remains,
          because it is a financial record.
        </p>
      ) : (
        <p className="client-data-panel__detail">
          Give this client a copy of everything held about them, or erase it.
          Erasure removes their address, entry codes, pet notes, route traces
          and photos. The billing ledger is kept — it is a financial record.
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
