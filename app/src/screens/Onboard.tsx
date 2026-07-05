// Onboard (phase 04): first-run operator setup. Creates the operators row
// (defaults GBP / Europe/London / threshold 2 come from the schema) and
// lands on the Dashboard. Skips straight through if a persona exists.
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Input } from "@/components/fields";
import { Spinner } from "@/components/Spinner";
import { createOperator } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export default function Onboard() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [businessName, setBusinessName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (auth.loading) return;
    if (!auth.session) navigate("/signin", { replace: true });
    else if (auth.role === "operator") navigate("/", { replace: true });
    else if (auth.role === "client") navigate("/portal", { replace: true });
  }, [auth.loading, auth.session, auth.role, navigate]);

  if (auth.loading || !auth.session || auth.role !== null) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await createOperator({
        id: auth.session!.user.id,
        business_name: businessName.trim(),
        display_name: displayName.trim(),
        email: auth.session!.user.email ?? "",
        phone: phone.trim() || null,
      });
      await auth.refreshRole();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create your business");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>Welcome to PawTrail</h1>
      <p style={{ color: "var(--text-2)", marginTop: "var(--s-1)" }}>
        Set up your walking business. Two default services (30 and 60 minute
        private walks) are created for you.
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
            placeholder="+44 7700 900000"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            error={error ?? undefined}
          />
          <p style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
            Currency GBP · timezone Europe/London · low-credit alerts at 2 —
            adjustable later.
          </p>
          <Button type="submit" full disabled={busy || !businessName.trim() || !displayName.trim()}>
            {busy ? <Spinner /> : "Start walking"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
