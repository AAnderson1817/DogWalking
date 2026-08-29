// The operator's half of review H4.
//
// Before this there was no surface at all: `invite_token` was in no UPDATE
// column grant and no RPC rotated it, so an invite could not be reissued, and
// the client row could not be deleted either once it had a pet, a property or
// a walk (every child FK is `on delete restrict`). A pet owner saying "please
// cancel that invite, I forwarded it by mistake" was told it was not possible.
//
// It renders only for an unclaimed client. Once an account is bound the token
// is spent and the panel would be describing something that cannot happen.
import { useState } from "react";
import { Badge, type BadgeStatus } from "./Badge";
import { Button } from "./Button";
import { FormError } from "./fields";
import { inviteState, inviteUrlFor, revokeInvite, rotateInvite } from "@/lib/api";
import { dateLocal } from "@/lib/format";
import type { Clients } from "@/lib/types";

const STATE_COPY: Record<
  Exclude<ReturnType<typeof inviteState>, "claimed">,
  { badge: BadgeStatus; label: string; detail: string }
> = {
  active: {
    badge: "scheduled",
    label: "Invite active",
    detail: "This link works until it expires. Anyone who has it can claim the account.",
  },
  expired: {
    badge: "neutral",
    label: "Invite expired",
    detail: "This link no longer works. Send a new one when the client is ready.",
  },
  revoked: {
    badge: "attention",
    label: "Invite withdrawn",
    detail: "You withdrew this link. It cannot be claimed. Send a new one to replace it.",
  },
};

export function InvitePanel({
  client,
  onChanged,
}: {
  client: Clients;
  onChanged: () => void;
}) {
  const [token, setToken] = useState(client.invite_token);
  const [busy, setBusy] = useState<"rotate" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const state = inviteState(client);
  if (state === "claimed") return null;
  const copy = STATE_COPY[state];

  async function act(kind: "rotate" | "revoke") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "rotate") {
        // The new token is returned rather than re-fetched, so the link on
        // screen is the one that was just minted. Re-reading the row would
        // race the operator pressing Copy.
        setToken(await rotateInvite(client.id));
      } else {
        await revokeInvite(client.id);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const url = inviteUrlFor(token);

  return (
    <section className="invite-panel" aria-labelledby="invite-panel-heading">
      <div className="invite-panel__head">
        <h2 id="invite-panel-heading" className="section-label">Invite</h2>
        <Badge status={copy.badge}>{copy.label}</Badge>
      </div>
      <p className="invite-panel__detail">{copy.detail}</p>

      {state !== "revoked" && (
        <>
          <code className="invite-link">{url}</code>
          {client.invite_expires_at && state === "active" && (
            <p className="invite-panel__expiry">
              Expires {dateLocal(client.invite_expires_at)}
            </p>
          )}
        </>
      )}

      <FormError message={error} />

      <div className="invite-panel__actions">
        {state === "active" && (
          <Button
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(url);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={busy !== null}
          onClick={() => void act("rotate")}
        >
          {busy === "rotate" ? "Sending…" : state === "active" ? "Send a new link" : "Send a new invite"}
        </Button>
        {state === "active" && (
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void act("revoke")}
          >
            {busy === "revoke" ? "Withdrawing…" : "Withdraw"}
          </Button>
        )}
      </div>
    </section>
  );
}
