// ClaimInvite (phase 04): /claim/:token. Signup (or existing session) →
// fn_preview_invite shows who the invite is for → fn_claim_invite binds the
// account → /portal. Invalid or already-claimed tokens hit a styled
// dead-end. Pre-signup, no client data is shown (anon has zero access —
// spec 03).
//
// Since review H31 the ACCOUNT is created by the public claim-signup edge
// function, not browser signUp: the invite is validated server-side before
// any account exists, which is what lets the GoTrue signup toggle be turned
// off without breaking this screen. The claim itself stays the
// authenticated fn_claim_invite call below, carrying the notice version.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/Button";
import { BrandLogo } from "@/components/BrandLogo";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { FormError, Input } from "@/components/fields";
import { Spinner } from "@/components/Spinner";
import { LoadingState, StateField } from "@/components/StateField";
import {
  claimInvite,
  claimSignup,
  InviteClaimError,
  inviteUrlFor,
  previewInviteAuthed,
  type InvitePreview,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { useDocumentTitle } from "@/lib/use-document-title";
import { LegalLinks } from "@/components/LegalLinks";
import { PRIVACY } from "@/lib/legal";

type Stage = "loading" | "signup" | "confirm" | "dead-end" | "check-email" | "role-error" | "claimed";

export default function ClaimInvite() {
  useDocumentTitle("Accept your invite");
  const { token } = useParams<{ token: string }>();
  const auth = useAuth();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>("loading");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [deadEndReason, setDeadEndReason] = useState("This invite link is not valid.");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPreview = useCallback(async () => {
    if (!token) {
      setStage("dead-end");
      return;
    }
    try {
      const p = await previewInviteAuthed(token);
      if (!p) {
        setDeadEndReason("This invite link is not valid. Ask your walker to send a fresh one.");
        setStage("dead-end");
      } else if (p.already_claimed) {
        setDeadEndReason("This invite has already been claimed. Try signing in instead.");
        setStage("dead-end");
      } else {
        setPreview(p);
        setStage("confirm");
      }
    } catch {
      setDeadEndReason("This invite link is not valid. Ask your walker to send a fresh one.");
      setStage("dead-end");
    }
  }, [token]);

  useEffect(() => {
    if (auth.loading) return;
    if (auth.role === "client") {
      navigate("/portal", { replace: true });
      return;
    }
    // An operator (or any already-provisioned account) must not consume a
    // client invite — fn_claim_invite would bind their uid and burn the
    // token, leaving them dual-persona with no reachable portal.
    if (auth.role === "operator") {
      setDeadEndReason(
        "You're signed in as an operator. Open this invite in a private window, " +
          "or sign out first, to claim it for the client.",
      );
      setStage("dead-end");
      return;
    }
    if (!auth.session) setStage("signup");
    else if (auth.roleError) setStage("role-error"); // don't strand on a spinner
    else void loadPreview();
  }, [auth.loading, auth.session, auth.role, auth.roleError, navigate, loadPreview]);

  async function signUp(e: FormEvent) {
    e.preventDefault();
    if (!token) {
      setStage("dead-end");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // Server-side account creation (H31): the invite is checked BEFORE the
      // account exists, so a dead link dead-ends with its 0039 sentence here
      // instead of leaving a fresh account with nothing to claim.
      await claimSignup(token, email, password);
      // The account exists (or already did — claim-signup deliberately
      // reports both as success). Sign in with what was just typed; a wrong
      // password on an existing account gets GoTrue's ordinary, rate-limited
      // sign-in answer below.
      const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
      if (err) {
        if ((err as { code?: string }).code === "email_not_confirmed" || /confirm/i.test(err.message)) {
          // Confirmations are on and the admin-created account is
          // unconfirmed — admin creation sends no email, so ask GoTrue to
          // send the confirmation now. The claim resumes when they return
          // signed in — which is why the redirect points BACK AT THIS
          // INVITE: without it the link lands on site_url ("/"), a
          // role-less signed-in user is routed to /onboard, and completing
          // that form mints an OPERATOR row that permanently dead-ends the
          // invite (adversarial review). GoTrue silently falls back to
          // site_url when the URL is not allowlisted, so the runbook adds
          // APP_BASE_URL/claim/* to the redirect allowlist.
          await supabase.auth.resend({
            type: "signup",
            email,
            // inviteUrlFor, not location.href: the canonical claim URL with
            // no stray query or fragment, matching the /claim/* allowlist
            // wildcard shape.
            options: { emailRedirectTo: inviteUrlFor(token) },
          });
          setStage("check-email");
          return;
        }
        setError(err.message);
        return;
      }
      if (!data.session) {
        setStage("check-email");
        return;
      }
      await loadPreview();
    } catch (err) {
      if (err instanceof InviteClaimError) {
        setDeadEndReason(err.message);
        setStage("dead-end");
        return;
      }
      setError(err instanceof Error ? err.message : "Could not create the account.");
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await claimInvite(token, PRIVACY.version);
      // The invite is now burned (fn_claim_invite is single-use). Branch on
      // the freshly resolved role instead of navigating blindly — but never
      // re-invoke claimInvite on retry (it would dead-end on the used token);
      // the 'claimed' stage retries role resolution only.
      const role = await auth.refreshRole();
      if (role === "client") {
        navigate("/portal", { replace: true });
      } else {
        setStage("claimed");
      }
    } catch (err) {
      // Before H4 this matched the substring "claim" against the error message
      // and reported "already claimed" for anything containing it — so an
      // expired link, a withdrawn one and a genuine network failure all read as
      // the same wrong sentence. The outcome is now a value, so the person is
      // told which of those actually happened and what to do about it.
      setDeadEndReason(
        err instanceof InviteClaimError
          ? err.message
          : "This invite could not be claimed. Check your connection and try again.",
      );
      setStage("dead-end");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ display: "grid", placeItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: "var(--s-6)" }}>
          <h1 className="sr-only">Accept your Sanpo invitation</h1>
          <BrandLogo />
          <p style={{ color: "var(--text-2)" }}>You've been invited.</p>
        </div>

        {stage === "loading" && (
          <LoadingState label="Checking your invitation" compact />
        )}

        {stage === "signup" && (
          <Card>
            <form onSubmit={signUp} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
              <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
                Create your account to see walk report cards, book walks, and
                manage your plan.
              </p>
              <Input
                label="Email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                label="Choose a password"
                type="password"
                autoComplete="new-password"
                required
                // claim-signup refuses under 12 (its PASSWORD_MIN_LENGTH,
                // mirroring config.toml); saying so here beats a round trip.
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={error ?? undefined}
              />
              <Button type="submit" full disabled={busy}>
                {busy ? <Spinner /> : "Create account"}
              </Button>
              <LegalLinks variant="accept" />
            </form>
          </Card>
        )}

        {stage === "confirm" && preview && (
          <Card>
            <div style={{ textAlign: "center", padding: "var(--s-2) 0" }}>
              <p style={{ fontWeight: 600, fontSize: "var(--fs-20)" }}>
                {preview.full_name}
              </p>
              <p style={{ color: "var(--text-2)", marginTop: "var(--s-1)" }}>
                {preview.business_name} invited you to your client portal.
              </p>
              <div style={{ marginTop: "var(--s-4)" }}>
                <Button full onClick={claim} disabled={busy}>
                  {busy ? <Spinner /> : "Accept invite"}
                </Button>
              </div>
              <FormError message={error} className="claim-invite__error" />
            </div>
          </Card>
        )}

        {stage === "check-email" && (
          <Card>
            <StateField
              tone="information"
              label="Next step"
              title="Confirm your email"
              detail={`We sent a confirmation link to ${email}. Open it, then return to this invite link to finish.`}
              role="status"
            />
          </Card>
        )}

        {stage === "role-error" && (
          <Card>
            <StateField
              tone="information"
              label="Connection interrupted"
              title="Couldn't reach your account"
              detail="Check your connection and try again."
              role="alert"
              action={
                <Button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void auth
                      .refreshRole()
                      .then((role) => {
                        if (role === "client") navigate("/portal", { replace: true });
                        else void loadPreview();
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  {busy ? <Spinner label="Retrying" /> : "Retry"}
                </Button>
              }
            />
          </Card>
        )}

        {stage === "claimed" && (
          <Card>
            <StateField
              tone="success"
              label="Complete"
              title="Invite accepted"
              detail="We're finishing your portal access."
              role="status"
              action={
                <Button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void auth
                      .refreshRole()
                      .then((role) => {
                        if (role === "client") navigate("/portal", { replace: true });
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  {busy ? <Spinner label="Loading your portal" /> : "Continue to my portal"}
                </Button>
              }
            />
          </Card>
        )}

        {stage === "dead-end" && (
          <Card>
            <EmptyState
              tone="information"
              label="Invite unavailable"
              title="Invite not available"
              hint={deadEndReason}
              action={
                <Button variant="ghost" onClick={() => navigate("/signin")}>
                  Go to sign in
                </Button>
              }
            />
          </Card>
        )}
      </div>
    </div>
  );
}
