// Editing a client record (backlog 1).
//
// The row was create-only in the product: `updateClient` shipped with zero
// importers, so a mistyped email could not be corrected and a client who moved
// house needed database surgery. Two designs already assumed this surface
// existed — spec 04 tells the operator a wrongly-reserved invite address is
// "recoverable the ordinary way: the operator edits the client's email", and
// `fn_unbind_invite` (0042) deliberately leaves `email` set when it releases a
// wrongly-claimed account, so the reissued invite stays bound to the wrong
// person until somebody edits it.
import { useId, useState, type FormEvent } from "react";
import { Button } from "./Button";
import { FormError, Input } from "./fields";
import { Sheet } from "./Sheet";
import { Spinner } from "./Spinner";
import { inviteState, updateClient, type ClientRecord } from "@/lib/api";
import {
  clientFormError,
  clientFormOf,
  clientPatch,
  emailEditEffect,
  type EmailEditEffect,
} from "@/lib/client-edit";

/**
 * What the operator is told before they save, and why each case has its own
 * sentence rather than one general warning.
 *
 * On an unclaimed client `email` is not contact detail — it is the last rung
 * of the claim ladder in `fn_claim_invite` and `fn_invite_signup_check`, so it
 * decides who may become the account. The three unclaimed cases have genuinely
 * different consequences and the operator cannot tell them apart from the
 * field alone.
 */
const EMAIL_EFFECT_COPY: Record<Exclude<EmailEditEffect, "unchanged">, string> = {
  "dormant-invite":
    "This client's invite isn't live, so nothing can be claimed with the old "
    + "link whatever this says. This is the address that will apply when you "
    + "send a new invite.",
  "contact-only":
    "This changes where their emails go. It does not change how they sign in — "
    + "their login keeps the address they signed up with.",
  "binds-invite":
    "This invite currently accepts whoever opens the link first. Saving an "
    + "address means only that address can claim it.",
  "rebinds-invite":
    "The invite link will stop working for the old address and start working "
    + "for this one.",
  "opens-invite":
    "Clearing the address means anyone who has the invite link can claim this "
    + "client's account. Withdraw the invite first if the link has been shared.",
};

/** The effects that change WHO MAY CLAIM — the ones the attention rule is for. */
const LADDER_EFFECTS = new Set<EmailEditEffect>([
  "binds-invite",
  "rebinds-invite",
  "opens-invite",
]);

export function ClientEditSheet({
  open,
  client,
  onClose,
  onSaved,
}: {
  open: boolean;
  client: ClientRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const noteId = useId();
  const [form, setForm] = useState(() => clientFormOf(client));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const invalid = clientFormError(form);
  const effect = emailEditEffect(client, form, inviteState(client));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = clientFormError(form);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const patch = clientPatch(client, form);
      // Saving an untouched form is a no-op rather than a write. `email` is
      // the column the invite ladder reads, and a surface that rewrites it on
      // every save can have an effect nobody asked for.
      if (patch) await updateClient(client.id, patch);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save those changes.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      // Refuse dismissal while the write is in flight. The only confirmation a
      // save worked is the header re-rendering, which an operator who tapped
      // the backdrop is not watching — so a PATCH that failed after dismissal
      // was indistinguishable from one that succeeded, on the field that
      // decides who may claim the invite.
      onClose={() => { if (!busy) onClose(); }}
      title={`Edit ${client.full_name}`}
    >
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <Input
          label="Full name"
          required
          value={form.full_name}
          onChange={(e) => set("full_name", e.target.value)}
        />
        <Input
          label="Email"
          type="email"
          value={form.email}
          aria-describedby={noteId}
          onChange={(e) => set("email", e.target.value)}
        />
        {/* Always mounted, for the same reason `FormError` is: a live region
            that appears together with its text is announced far less reliably
            than one that already exists when the text arrives. `:empty` takes
            it out of flow, so it costs no `gap` while there is nothing to say.
            role="status" rather than alert — this is a consequence of what the
            operator is typing, not a failure. */}
        <p
          id={noteId}
          // Kaki only for the notes that change who may claim the account.
          className={`form-note${LADDER_EFFECTS.has(effect) ? " form-note--attention" : ""}`}
          role="status"
        >
          {effect === "unchanged" ? null : EMAIL_EFFECT_COPY[effect]}
        </p>
        <Input
          label="Phone"
          type="tel"
          value={form.phone}
          onChange={(e) => set("phone", e.target.value)}
        />
        <FormError message={error} />
        <Button type="submit" full disabled={busy || invalid !== null}>
          {busy ? <Spinner /> : "Save changes"}
        </Button>
      </form>
    </Sheet>
  );
}
