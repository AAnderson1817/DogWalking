// Two-factor enrolment (review H2's client half).
//
// The vault's graduated gate has been live since the H2 fix: enrolling a
// verified TOTP factor is what closes the stolen-session-to-vault chain,
// with no server change — but no surface existed to enroll one, so the
// posture the gate was built for was unreachable. This section is that
// surface: enroll → scan → verify, and verifying upgrades the CURRENT
// session to aal2 in place, so the vault works immediately.
//
// Turning it off requires a current code, deliberately: a session-only
// attacker being able to remove the factor would delete the exact control
// that exists to contain a stolen session. The honest edge that leaves —
// a lost authenticator cannot be removed from inside the product — is
// stated in the copy rather than papered over; recovery is the owner's
// dashboard (docs/dev/auth-posture.md).
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { FormError, Input } from "@/components/fields";
import { Spinner } from "@/components/Spinner";
import {
  beginTotpEnrolment,
  confirmTotpEnrolment,
  fetchVerifiedFactor,
  removeTotpFactor,
  stepUpWithCode,
  type TotpEnrolment,
} from "@/lib/mfa";

type View =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "off" }
  | { kind: "enrolling"; enrolment: TotpEnrolment }
  | { kind: "on"; factorId: string }
  | { kind: "removing"; factorId: string };

export function MfaSection() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Focus target for view transitions that unmount the control being
  // pressed: without it, completing (or cancelling) an action drops
  // keyboard and screen-reader focus to <body> at the bottom of a long
  // Settings page (adversarial review). The role=status notice covers the
  // announcement; this covers where the keyboard IS.
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const load = useCallback(async () => {
    try {
      const factor = await fetchVerifiedFactor();
      setView(factor ? { kind: "on", factorId: factor.id } : { kind: "off" });
    } catch (e) {
      // Distinct from "off" on purpose: rendering the setup button on a
      // failed read invites an enrolment attempt that will also fail, with
      // a worse error further in.
      setView({
        kind: "unavailable",
        message: e instanceof Error ? e.message : "Could not check two-factor status.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function begin() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const enrolment = await beginTotpEnrolment();
      setCode("");
      setView({ kind: "enrolling", enrolment });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start two-factor setup.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent, enrolment: TotpEnrolment) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await confirmTotpEnrolment(enrolment.factorId, code.trim());
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setCode("");
    setNotice(
      "Two-factor authentication is on. Opening the vault now requires a code from your app.",
    );
    setView({ kind: "on", factorId: enrolment.factorId });
    headingRef.current?.focus();
  }

  async function remove(e: FormEvent, factorId: string) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // The code first: removing a verified factor needs an aal2 session, and
    // demanding the code IS the policy — turning two-factor off requires
    // having it.
    const stepErr = await stepUpWithCode(factorId, code.trim());
    if (stepErr) {
      setBusy(false);
      setError(stepErr);
      return;
    }
    const err = await removeTotpFactor(factorId);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setCode("");
    setNotice("Two-factor authentication is off.");
    setView({ kind: "off" });
    headingRef.current?.focus();
  }

  return (
    <section className="settings-section" aria-labelledby="settings-mfa">
      <h2 id="settings-mfa" className="section-label" tabIndex={-1} ref={headingRef}>
        Two-factor authentication
      </h2>
      <p role="status" className="settings-notice">{notice}</p>
      {/* One always-mounted error region for the whole section: a failed
          'Turn on two-factor' click used to store an error the off view had
          nowhere to render — the spinner stopped and nothing else happened
          (adversarial review) — and FormError's own contract wants the live
          region mounted BEFORE its text arrives. */}
      <FormError message={view.kind === "unavailable" ? view.message : error} />

      {view.kind === "loading" && <Spinner />}

      {view.kind === "unavailable" && (
        <Button variant="ghost" onClick={() => { setView({ kind: "loading" }); void load(); }}>
          Try again
        </Button>
      )}

      {view.kind === "off" && (
        <>
          <p>
            Your password alone stands between a stolen session and every entry
            code in your vault. Add an authenticator app and the vault will
            also require a six-digit code — a phone thief can't fake one.
          </p>
          <Button onClick={() => void begin()} disabled={busy}>
            {busy ? <Spinner /> : "Turn on two-factor"}
          </Button>
        </>
      )}

      {view.kind === "enrolling" && (
        <form
          onSubmit={(e) => void verify(e, view.enrolment)}
          style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}
        >
          <p>
            Scan this with an authenticator app (1Password, Google
            Authenticator, Authy…), then enter the six-digit code it shows.
          </p>
          <img
            src={view.enrolment.qrCode}
            alt="QR code for your authenticator app"
            width={176}
            height={176}
            // Deliberately pinned to production white in BOTH themes: a QR
            // code on a tinted or dark surface scans worse, and this image
            // exists for exactly one scan.
            style={{
              background: "var(--sanpo-color-production-white)",
              borderRadius: "var(--r-md)",
              padding: "var(--s-2)",
            }}
          />
          <p style={{ fontSize: "var(--fs-14)" }}>
            On this device?{" "}
            <a href={view.enrolment.uri}>Open in your authenticator app</a> —
            a phone can't scan its own screen. Or enter this key by hand:{" "}
            <code style={{ userSelect: "all", WebkitUserSelect: "all", overflowWrap: "anywhere" }}>
              {view.enrolment.secret}
            </code>
          </p>
          <Input
            label="Six-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
          <Button type="submit" disabled={busy || !code.trim()}>
            {busy ? <Spinner /> : "Verify and turn on"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setCode("");
              setError(null);
              setView({ kind: "off" });
              headingRef.current?.focus();
            }}
          >
            Cancel
          </Button>
        </form>
      )}

      {view.kind === "on" && (
        <>
          <p>
            Two-factor authentication is <strong>on</strong>. Opening the vault
            requires a code from your authenticator app. If you lose the app,
            it can't be removed from here — contact Sanpo support, who will
            remove it after verifying it's really you. Keep the app backed up.
          </p>
          <Button
            variant="ghost"
            onClick={() => { setCode(""); setError(null); setView({ kind: "removing", factorId: view.factorId }); }}
          >
            Turn off two-factor
          </Button>
        </>
      )}

      {view.kind === "removing" && (
        <form
          onSubmit={(e) => void remove(e, view.factorId)}
          style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}
        >
          <p>
            Turning two-factor off requires a current code — that's the point
            of it.
          </p>
          <Input
            label="Six-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
          <Button type="submit" disabled={busy || !code.trim()}>
            {busy ? <Spinner /> : "Turn off"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => { setCode(""); setError(null); setView({ kind: "on", factorId: view.factorId }); }}
          >
            Keep it on
          </Button>
        </form>
      )}
    </section>
  );
}
