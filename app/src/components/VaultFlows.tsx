// Shared credential vault flows (phase 05), used by AccessVault and the
// ClientDetail Access tab. Reveal: reauth sheet → required purpose →
// credential-vault get → plaintext shown for 30 s with manual copy, then
// auto-cleared. Put: new secret or rotation. Every reveal writes exactly
// one audit row server-side (fn_read_credential).
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "./Button";
import { FormError, Input, Select } from "./fields";
import { Sheet } from "./Sheet";
import { Spinner } from "./Spinner";
import { LoadingState, StateField } from "./StateField";
import {
  listCredentialLog,
  vaultDelete,
  vaultGet,
  vaultPut,
  type CredentialLogRow,
  type CredentialMeta,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { dateLocal, timeLocal } from "@/lib/format";

const ENTRY_METHODS = [
  "key_on_file",
  "lockbox",
  "smart_lock",
  "door_code",
  "buzzer_fob",
] as const;

const METHOD_LABELS: Record<string, string> = {
  key_on_file: "Key on file",
  lockbox: "Lockbox",
  smart_lock: "Smart lock",
  door_code: "Door code",
  buzzer_fob: "Buzzer / fob",
};

// oxlint-disable-next-line react/only-export-components
export function entryMethodLabel(method: string): string {
  return METHOD_LABELS[method] ?? method;
}

const REVEAL_SECONDS = 30;

/** One credential row with reveal / rotate / revoke / audit actions. */
export function CredentialRow({
  credential,
  onChanged,
}: {
  credential: CredentialMeta;
  onChanged: () => void;
}) {
  const { reauth } = useAuth();
  const [purposeOpen, setPurposeOpen] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REVEAL_SECONDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [audit, setAudit] = useState<CredentialLogRow[] | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 30 s auto-clear (spec/phase 05).
  useEffect(() => {
    if (secret === null) return;
    setCountdown(REVEAL_SECONDS);
    clearTimerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          setSecret(null);
          return REVEAL_SECONDS;
        }
        return c - 1;
      });
    }, 1000);
    return () => {
      if (clearTimerRef.current) clearInterval(clearTimerRef.current);
    };
  }, [secret]);

  async function reveal(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const password = await reauth();
    if (password === null) return;
    setBusy(true);
    try {
      const result = await vaultGet({
        credential_id: credential.id,
        purpose: purpose.trim(),
        password,
      });
      setSecret(result.secret);
      setPurposeOpen(false);
      setPurpose("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "reveal failed");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm("Revoke this credential? The audit trail is kept.")) return;
    const password = await reauth();
    if (password === null) return;
    setBusy(true);
    try {
      await vaultDelete({ credential_id: credential.id, password });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "revoke failed");
    } finally {
      setBusy(false);
    }
  }

  async function openAudit() {
    setAuditOpen(true);
    setAudit(await listCredentialLog(credential.id).catch(() => []));
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-2)",
        padding: "var(--s-3) 0",
        borderBottom: "1px solid var(--mist)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s-2)" }}>
        <div>
          <div style={{ fontWeight: 600 }}>{credential.label ?? entryMethodLabel(credential.entry_method)}</div>
          <div style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
            {entryMethodLabel(credential.entry_method)}
            {credential.key_location_hint ? ` · ${credential.key_location_hint}` : ""}
            {credential.rotated_at ? ` · rotated ${dateLocal(credential.rotated_at)}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: "var(--s-1)", flexShrink: 0 }}>
          <Button variant="ghost" onClick={() => setPurposeOpen(true)} disabled={busy}>
            Reveal
          </Button>
        </div>
      </div>

      {secret !== null && (
        // Painted by .vault-reveal, not inline styles: this panel used to
        // route through the legacy --pine-950 / --teal-live aliases, which
        // the Sanpo remap resolved to Indigo on Asagi — 1.70:1 for the code
        // itself, and a Copy button filled with the panel's own Indigo at
        // 1.00:1. Cream on Indigo is 9.03:1.
        <div className="vault-reveal">
          <code className="numeral vault-reveal__code">{secret}</code>
          <Button
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(secret)}
          >
            Copy
          </Button>
          <span className="numeral vault-reveal__countdown" aria-hidden>
            {countdown}s
          </span>
          {/* The visible countdown is a glance affordance; this is the same
              information for a screen reader, announced politely at 10 s and
              then each of the last five seconds rather than every tick. */}
          <span className="sr-only" role="status">
            {countdown === 10 || countdown <= 5
              ? `Code clears in ${countdown} second${countdown === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
      )}
      <FormError message={error} />

      <div style={{ display: "flex", gap: "var(--s-3)" }}>
        <LinkButton onClick={() => setRotateOpen(true)}>Rotate</LinkButton>
        <LinkButton onClick={() => void openAudit()}>Audit trail</LinkButton>
        <LinkButton onClick={() => void revoke()} danger>
          Revoke
        </LinkButton>
      </div>

      <Sheet open={purposeOpen} onClose={() => setPurposeOpen(false)} title="Why do you need this?">
        <form onSubmit={reveal} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
            The purpose is recorded in the audit trail with the timestamp.
          </p>
          <Input
            label="Purpose"
            required
            placeholder="Pre-walk entry, 12:00 visit"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
          <Button type="submit" full disabled={busy || purpose.trim().length === 0}>
            {busy ? <Spinner /> : "Confirm & reveal"}
          </Button>
        </form>
      </Sheet>

      <PutCredentialSheet
        open={rotateOpen}
        onClose={() => setRotateOpen(false)}
        credential={credential}
        onSaved={() => {
          setRotateOpen(false);
          onChanged();
        }}
      />

      <Sheet open={auditOpen} onClose={() => setAuditOpen(false)} title="Audit trail">
        {audit === null ? (
          <LoadingState label="Loading audit trail" compact />
        ) : audit.length === 0 ? (
          <StateField compact title="No reveals recorded" detail="This credential has not been opened yet." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            {audit.map((row) => (
              <div key={row.id} style={{ borderBottom: "1px solid var(--mist)", paddingBottom: "var(--s-2)" }}>
                <div style={{ fontWeight: 600, fontSize: "var(--fs-14)" }}>{row.purpose}</div>
                <div style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
                  {dateLocal(row.accessed_at)} · {timeLocal(row.accessed_at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}

/** Create or rotate a credential (vault put). */
export function PutCredentialSheet({
  open,
  onClose,
  onSaved,
  propertyId,
  credential,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** Required for a new credential. */
  propertyId?: string;
  /** Present when rotating an existing credential. */
  credential?: CredentialMeta;
}) {
  const { reauth } = useAuth();
  const [entryMethod, setEntryMethod] = useState<string>(credential?.entry_method ?? "lockbox");
  const [label, setLabel] = useState(credential?.label ?? "");
  const [secret, setSecret] = useState("");
  const [hint, setHint] = useState(credential?.key_location_hint ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const password = await reauth();
    if (password === null) return;
    setBusy(true);
    try {
      await vaultPut({
        credential_id: credential?.id,
        property_id: credential ? undefined : propertyId,
        entry_method: entryMethod,
        label: label.trim() || undefined,
        secret,
        key_location_hint: hint.trim() || undefined,
        password,
      });
      setSecret("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={credential ? "Rotate secret" : "Add credential"}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <Select label="Entry method" value={entryMethod} onChange={(e) => setEntryMethod(e.target.value)}>
          {ENTRY_METHODS.map((m) => (
            <option key={m} value={m}>
              {entryMethodLabel(m)}
            </option>
          ))}
        </Select>
        <Input label="Label" placeholder="Front door" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Input
          label={credential ? "New secret" : "Secret"}
          required
          placeholder="Code, key location, alarm sequence…"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
        />
        <Input
          label="Non-secret hint (optional)"
          placeholder="Left of the porch, behind the planter"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          error={error ?? undefined}
        />
        <p style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
          Stored encrypted (AES-256-GCM). Nobody — including you — can read it
          back without a fresh password check, and every reveal is audited.
        </p>
        <Button type="submit" full disabled={busy || secret.length === 0}>
          {busy ? <Spinner /> : credential ? "Rotate" : "Encrypt & save"}
        </Button>
      </form>
    </Sheet>
  );
}

function LinkButton({
  onClick,
  children,
  danger,
}: {
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      className={`text-button${danger ? " text-button--danger" : ""}`}
      onClick={onClick}
      style={{
        fontSize: "var(--fs-12)",
      }}
    >
      {children}
    </button>
  );
}
