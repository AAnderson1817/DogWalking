// SignIn (phase 04): email+password with a magic-link option; redirects to
// the persona home once auth-context resolves the role.
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Input } from "@/components/fields";
import { Spinner } from "@/components/Spinner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

export default function SignIn() {
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
          <h1 className="display" style={{ fontSize: "var(--fs-32)" }}>PawTrail</h1>
          <p style={{ color: "var(--text-2)" }}>Walks, credits, report cards.</p>
        </div>
        <Card>
          {magicSent ? (
            <div style={{ textAlign: "center", padding: "var(--s-4) 0" }}>
              <p style={{ fontWeight: 600 }}>Check your email</p>
              <p style={{ color: "var(--text-2)", marginTop: "var(--s-2)" }}>
                We sent a sign-in link to {email}.
              </p>
            </div>
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
              {mode === "magic" && error && <span className="field__error">{error}</span>}
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
      </div>
    </div>
  );
}
