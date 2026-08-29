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
import { useAuth } from "@/lib/auth-context";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function SignIn() {
  useDocumentTitle("Sign in");
  const auth = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"password" | "magic">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [magicSent, setMagicSent] = useState(false);

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
      } else {
        const { error: err } = await supabase.auth.signInWithOtp({ email });
        if (err) setError(err.message);
        else setMagicSent(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ display: "grid", placeItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
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
              {mode === "magic" && <FormError message={error} />}
              <Button type="submit" full disabled={busy}>
                {busy ? <Spinner /> : mode === "password" ? "Sign in" : "Email me a link"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                full
                onClick={() => {
                  setMode((m) => (m === "password" ? "magic" : "password"));
                  setError(null);
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
