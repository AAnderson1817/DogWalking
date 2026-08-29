// Where a password-reset email lands (review L16).
//
// Supabase's recovery link goes to GoTrue, which verifies the token and
// redirects here with a session in the URL fragment. `supabase-js` picks that
// up on load (`detectSessionInUrl` defaults to true) and fires
// `PASSWORD_RECOVERY`, so by the time this screen has a session the person is
// authenticated well enough to set a password and nothing else needs checking.
//
// The screen has three states and each is a different sentence: still reading
// the link, no recovery session at all (the link expired, or somebody typed
// the URL), and the form.
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { FormError, Input } from "@/components/fields";
import { Spinner } from "@/components/Spinner";
import { StateField } from "@/components/StateField";
import { supabase } from "@/lib/supabase";
import { PASSWORD_HELP, passwordPolicyProblem } from "@/lib/password-policy";
import { useDocumentTitle } from "@/lib/use-document-title";

type Phase = "reading" | "no-session" | "form" | "done";

export default function ResetPassword() {
  useDocumentTitle("Set a new password");
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("reading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    // `getSession()` rather than reading the fragment ourselves: the client
    // has already consumed and cleared it by the time a component mounts, and
    // parsing it a second time would be a second implementation of GoTrue's
    // token format.
    void supabase.auth.getSession().then(({ data }) => {
      if (!live) return;
      setPhase(data.session ? "form" : "no-session");
    });
    // A session can also arrive AFTER the first render — the URL parse is
    // async, and on a slow load `getSession()` above resolves to null first.
    // Without this the screen would settle on "link expired" for somebody
    // holding a link that is perfectly good.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (live && session) setPhase((p) => (p === "done" ? p : "form"));
    });
    return () => {
      live = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Those don't match.");
      return;
    }
    // Courtesy check only; GoTrue enforces the same rule and its refusal is
    // surfaced below rather than swallowed.
    const problem = passwordPolicyProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setPhase("done");
    // The recovery session is a real session, so they are already signed in.
    // Sending them to `/` lets `RequireRole` route them to their own persona
    // home rather than this screen guessing which one they are.
    setTimeout(() => navigate("/", { replace: true }), 1200);
  }

  return (
    <div className="page page--centered">
      <div>
        <h1 className="sr-only">Set a new password</h1>
        <BrandLogo className="brand-logo--small" />
        <Card>
          {phase === "reading" ? (
            <Spinner label="Checking your link" />
          ) : phase === "no-session" ? (
            <StateField
              tone="attention"
              label="Link expired"
              title="This reset link can't be used"
              detail="Reset links work once and expire after an hour. Ask for a new one and it'll arrive in a moment."
              role="alert"
              action={<Link className="secondary-link" to="/signin">Back to sign in</Link>}
            />
          ) : phase === "done" ? (
            <StateField
              tone="success"
              label="Saved"
              title="Password updated"
              detail="You're signed in. Taking you to your account…"
              role="status"
            />
          ) : (
            <form
              onSubmit={submit}
              style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}
            >
              <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)", margin: 0 }}>
                {PASSWORD_HELP}
              </p>
              <Input
                label="New password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              <Input
                label="Confirm password"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              <FormError message={error} />
              <Button type="submit" full disabled={!password || !confirm || busy}>
                {busy ? <Spinner /> : "Save password"}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
