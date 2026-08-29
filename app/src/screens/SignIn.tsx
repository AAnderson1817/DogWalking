// SignIn (phase 04): email+password with a magic-link option; redirects to
// the persona home once auth-context resolves the role.
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { BrandLogo } from "@/components/BrandLogo";
import { Card } from "@/components/Card";
import { FormError, Input } from "@/components/fields";
import { Spinner } from "@/components/Spinner";
import { StateField } from "@/components/StateField";
import { LegalLinks } from "@/components/LegalLinks";
import { supabase } from "@/lib/supabase";
import { describeResetOutcome, resetRedirectUrl, type ResetOutcome } from "@/lib/password-reset";
import { useAuth } from "@/lib/auth-context";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function SignIn() {
  useDocumentTitle("Sign in");
  const auth = useAuth();
  const navigate = useNavigate();
  // `reset` is a third mode rather than a separate route: the person is
  // already on the screen with their email in the field, and bouncing them
  // to /forgot-password to retype it is the friction that makes people give
  // up and email the operator instead (review L16).
  const [mode, setMode] = useState<"password" | "magic" | "reset">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [resetOutcome, setResetOutcome] = useState<ResetOutcome | null>(null);

  // Redirect once a session exists and the role is resolved. Never redirect
  // to onboarding when resolution errored — that's not a "no persona" signal.
  useEffect(() => {
    if (auth.loading || !auth.session || auth.roleError) return;
    if (auth.role === "operator") navigate("/", { replace: true });
    else if (auth.role === "client") navigate("/portal", { replace: true });
    else navigate("/onboard", { replace: true });
  }, [auth.loading, auth.session, auth.role, auth.roleError, navigate]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "password") {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) setError(err.message);
      } else if (mode === "magic") {
        const { error: err } = await supabase.auth.signInWithOtp({ email });
        if (err) setError(err.message);
        else setMagicSent(true);
      } else {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: resetRedirectUrl(window.location.origin),
        });
        // The message is decided by `describeResetOutcome`, not here: whether
        // the address has an account must not change what this screen says.
        setResetOutcome(describeResetOutcome(err, email));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    // `page--centered` carries the centring and the 400px measure that were
    // inline here (review L16, and M38's inline-style count).
    <div className="page page--centered">
      <div>
        <div style={{ textAlign: "center", marginBottom: "var(--s-6)" }}>
          {/* The logo is the visual heading; this is the same thing for
              heading navigation, which the logo alone cannot serve. */}
          <h1 className="sr-only">Sign in to Sanpo</h1>
          <BrandLogo />
          <p style={{ color: "var(--text-2)" }}>Business tools for independent pet pros.</p>
        </div>
        <Card>
          {auth.session && auth.roleError ? (
            <StateField
              tone="information"
              label="Connection interrupted"
              title="Couldn't load your account"
              detail="You're signed in, but the server couldn't be reached. Check your connection and try again."
              role="alert"
              action={
                <Button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void auth.refreshRole().finally(() => setBusy(false));
                  }}
                >
                  {busy ? <Spinner label="Retrying" /> : "Retry"}
                </Button>
              }
            />
          ) : magicSent ? (
            <StateField
              tone="success"
              label="Email sent"
              title="Check your email"
              detail={`We sent a sign-in link to ${email}.`}
              role="status"
            />
          ) : resetOutcome?.tone === "success" ? (
            <StateField
              tone="success"
              label="Email sent"
              title="Check your email"
              detail={resetOutcome.message}
              role="status"
              action={
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setResetOutcome(null);
                    setMode("password");
                  }}
                >
                  Back to sign in
                </button>
              }
            />
          ) : (
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
              <Input
                label="Email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {mode === "password" && (
                <Input
                  label="Password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  error={error ?? undefined}
                />
              )}
              {mode === "reset" && (
                <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)", margin: 0 }}>
                  We'll email you a link to set a new password.
                </p>
              )}
              {mode !== "password" && (
                <FormError message={resetOutcome?.tone === "error" ? resetOutcome.message : error} />
              )}
              <Button type="submit" full disabled={busy}>
                {busy
                  ? <Spinner />
                  : mode === "password"
                    ? "Sign in"
                    : mode === "magic"
                      ? "Email me a link"
                      : "Email me a reset link"}
              </Button>
              {/* Recovery is its own affordance, not a re-reading of the magic
                  link. The magic link is presented as another way to sign IN;
                  somebody who has forgotten their password is looking for the
                  word "forgot", and until now the grep for it returned nothing
                  (review L16). */}
              {mode === "password" && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setMode("reset");
                    setError(null);
                    setPassword("");
                  }}
                >
                  Forgot your password?
                </button>
              )}
              <Button
                type="button"
                variant="ghost"
                full
                onClick={() => {
                  setMode((m) => (m === "password" ? "magic" : "password"));
                  setError(null);
                  setResetOutcome(null);
                }}
              >
                {mode === "password" ? "Use a magic link instead" : "Use a password instead"}
              </Button>
            </form>
          )}
        </Card>
        <LegalLinks variant="accept" />
      </div>
    </div>
  );
}
