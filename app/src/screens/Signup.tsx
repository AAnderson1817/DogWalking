// /signup — the explicit operator front door (review H31).
//
// Deliberately the ONE remaining public `supabase.auth.signUp` in the tree:
// client accounts come from claim-signup (server-side, invite-gated), so
// this call is what the GoTrue "allow new users to sign up" toggle now
// controls. Owner closes signups → this screen starts refusing → operator
// acquisition is a decision instead of an accident. Do not add another.
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { FormError, Input } from "@/components/fields";
import { LegalLinks } from "@/components/LegalLinks";
import { Spinner } from "@/components/Spinner";
import { StateField } from "@/components/StateField";
import { useAuth } from "@/lib/auth-context";
import { money } from "@/lib/format";
import { PLATFORM_PRICE_PENCE, TRIAL_DAYS } from "@/lib/operator-access";
import { supabase } from "@/lib/supabase";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function Signup() {
  useDocumentTitle("Start your free trial");
  const auth = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  // Already signed in: this is not the screen for them.
  useEffect(() => {
    if (auth.loading || !auth.session) return;
    if (auth.role === "operator") navigate("/", { replace: true });
    else if (auth.role === "client") navigate("/portal", { replace: true });
    else if (!auth.roleError) navigate("/onboard", { replace: true });
  }, [auth.loading, auth.session, auth.role, auth.roleError, navigate]);

  // Signed in but role resolution FAILED: none of the redirects above fired,
  // and leaving the live form on screen makes "submit again" the visible
  // affordance — which re-signs-up the very account whose lookup blipped.
  // Same retry treatment SignIn gives the identical state.
  if (auth.session && auth.role === null && auth.roleError) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <div style={{ width: "100%", maxWidth: 400 }}>
          <h1 className="sr-only">Start your Sanpo free trial</h1>
          <Card>
            <StateField
              tone="information"
              label="Connection interrupted"
              title="Couldn't load your account"
              detail="You're signed in, but we couldn't check your account. Retry rather than signing up again."
              role="alert"
              action={
                <Button disabled={busy} onClick={() => void auth.refreshRole()}>
                  Retry
                </Button>
              }
            />
          </Card>
        </div>
      </div>
    );
  }

  async function submit(e: FormEvent) {
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
        // Email confirmation is on: Onboard continues once they verify.
        setCheckEmail(true);
        return;
      }
      navigate("/onboard", { replace: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ display: "grid", placeItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: "var(--s-6)" }}>
          <h1 className="sr-only">Start your Sanpo free trial</h1>
          <BrandLogo />
          <p style={{ color: "var(--text-2)" }}>
            {TRIAL_DAYS} days free, then {money(PLATFORM_PRICE_PENCE)}/month.{" "}
            <Link to="/pricing">What's included</Link>
          </p>
        </div>

        {checkEmail
          ? (
            <Card>
              <StateField
                tone="information"
                label="Next step"
                title="Confirm your email"
                detail={`We sent a confirmation link to ${email}. Open it to finish setting up your business.`}
                role="status"
              />
            </Card>
          )
          : (
            <Card>
              <form
                onSubmit={submit}
                style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}
              >
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
                  // config.toml's minimum_password_length; saying it here
                  // beats a server round trip. This password also guards the
                  // credential vault's re-auth, so the floor is not ceremony.
                  minLength={12}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <FormError message={error} />
                <Button type="submit" full disabled={busy}>
                  {busy ? <Spinner /> : "Create my account"}
                </Button>
                <p style={{ textAlign: "center", fontSize: "var(--fs-14)", margin: 0 }}>
                  Already have an account? <Link to="/signin">Sign in</Link>
                </p>
              </form>
            </Card>
          )}
        <LegalLinks variant="accept" />
      </div>
    </div>
  );
}
