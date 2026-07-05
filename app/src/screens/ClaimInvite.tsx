// ClaimInvite (phase 04): /claim/:token. Signup (or existing session) →
// fn_preview_invite shows who the invite is for → fn_claim_invite binds the
// account → /portal. Invalid or already-claimed tokens hit a styled
// dead-end. Pre-signup, no client data is shown (anon has zero access —
// spec 03).
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/fields";
import { Spinner } from "@/components/Spinner";
import { claimInvite, previewInviteAuthed, type InvitePreview } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";

type Stage = "loading" | "signup" | "confirm" | "dead-end" | "check-email";

export default function ClaimInvite() {
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
    if (!auth.session) setStage("signup");
    else void loadPreview();
  }, [auth.loading, auth.session, auth.role, navigate, loadPreview]);

  async function signUp(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { data, error: err } = await supabase.auth.signUp({ email, password });
      if (err) {
        setError(err.message);
        return;
      }
      if (!data.session) {
        // Email confirmation is on: the claim continues after they verify
        // and return signed in.
        setStage("check-email");
        return;
      }
      await loadPreview();
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await claimInvite(token);
      await auth.refreshRole();
      navigate("/portal", { replace: true });
    } catch (err) {
      setDeadEndReason(
        err instanceof Error && err.message.includes("claim")
          ? "This invite has already been claimed."
          : "This invite could not be claimed. Ask your walker to send a fresh one.",
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
          <h1 className="display" style={{ fontSize: "var(--fs-32)" }}>PawTrail</h1>
          <p style={{ color: "var(--text-2)" }}>You've been invited.</p>
        </div>

        {stage === "loading" && (
          <div style={{ display: "grid", placeItems: "center" }}>
            <Spinner />
          </div>
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
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={error ?? undefined}
              />
              <Button type="submit" full disabled={busy}>
                {busy ? <Spinner /> : "Create account"}
              </Button>
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
            </div>
          </Card>
        )}

        {stage === "check-email" && (
          <Card>
            <div style={{ textAlign: "center", padding: "var(--s-4) 0" }}>
              <p style={{ fontWeight: 600 }}>Confirm your email</p>
              <p style={{ color: "var(--text-2)", marginTop: "var(--s-2)" }}>
                We sent a confirmation link to {email}. Open it, then return to
                this invite link to finish.
              </p>
            </div>
          </Card>
        )}

        {stage === "dead-end" && (
          <Card>
            <EmptyState
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
