// Onboard (phase 04): first-run operator setup. Creates the operators row
// (defaults USD / America/Chicago / threshold 2 come from the schema) and
// lands on the Dashboard. Skips straight through if a persona exists.
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { FormError, Input } from "@/components/fields";
import { Spinner } from "@/components/Spinner";
import { LoadingState, StateField } from "@/components/StateField";
import { createOperator } from "@/lib/api";
import { LegalLinks } from "@/components/LegalLinks";
import { TERMS } from "@/lib/legal";
import { useAuth } from "@/lib/auth-context";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function Onboard() {
  useDocumentTitle("Set up your business");
  const auth = useAuth();
  const navigate = useNavigate();
  const [businessName, setBusinessName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (auth.loading || auth.roleError) return;
    if (!auth.session) navigate("/signin", { replace: true });
    else if (auth.role === "operator") navigate("/", { replace: true });
    else if (auth.role === "client") navigate("/portal", { replace: true });
  }, [auth.loading, auth.session, auth.role, auth.roleError, navigate]);

  // Show the form only when the user genuinely has no persona. If resolution
  // errored, hold on a retryable state rather than the operator setup form.
  if (auth.roleError) {
    return (
      <div className="page">
        <StateField
          tone="information"
          label="Connection interrupted"
          title="Couldn't confirm your account"
          detail="Check your connection and try again."
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
      </div>
    );
  }
  if (auth.loading || !auth.session || auth.role !== null) {
    return (
      <div className="page">
        <LoadingState label="Loading account setup" />
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      try {
        await createOperator({
          id: auth.session!.user.id,
          business_name: businessName.trim(),
          display_name: displayName.trim(),
          email: auth.session!.user.email ?? "",
          phone: phone.trim() || null,
          // Review H6. Recorded in the same insert as the account, so an
          // operator row without an acceptance is not a state that occurs.
          terms_version: TERMS.version,
          terms_accepted_at: new Date().toISOString(),
        });
      } catch (err) {
        // Idempotent retry: if a previous submit already created the row
        // (e.g. the redirect failed afterwards), fall through to the role
        // refresh instead of dead-ending on the duplicate-key error.
        const msg = err instanceof Error ? err.message : "";
        if (!/duplicate key|already exists/i.test(msg)) throw err;
      }
      const role = await auth.refreshRole();
      if (role === "operator") {
        navigate("/", { replace: true });
      } else {
        setError(
          "Your business was saved, but your role could not be confirmed. " +
            "Reload the page; if this persists, check the browser console.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create your business");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>Welcome to Sanpo</h1>
      <p style={{ color: "var(--text-2)", marginTop: "var(--s-1)" }}>
        Set up your walking business. Two default services (30 and 60 minute
        private walks) are created for you.
      </p>
      {/* The wrong-form trap (H31): a signed-in user with no persona lands
          here whether they are a new WALKER or an invited PET OWNER whose
          confirmation link lost its way — and completing this form as the
          latter mints an operator row that dead-ends their invite for good. */}
      <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
        Invited by your dog walker? Don't fill this in — open the invite link
        from your email instead; this form creates a walker account.
      </p>
      <Card style={{ marginTop: "var(--s-4)" }}>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          <Input
            label="Business name"
            required
            placeholder="Pine & Paws"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
          />
          <Input
            label="Your name"
            required
            placeholder="Sam"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <Input
            label="Phone (optional)"
            type="tel"
            placeholder="+1 (555) 019-2830"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <FormError message={error} />
          <p style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
            Currency USD · timezone US Central · low-credit alerts at 2 —
            adjustable later.
          </p>
          <Button type="submit" full disabled={busy || !businessName.trim() || !displayName.trim()}>
            {busy ? <Spinner /> : "Start walking"}
          </Button>
        </form>
        <LegalLinks variant="accept" />
      </Card>
    </div>
  );
}
