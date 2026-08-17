// Roster (phase 05): searchable client list (by name or pet), status
// badges, balance chips → ClientDetail. Includes add-client with invite
// link handoff.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/fields";
import { Sheet } from "@/components/Sheet";
import { Spinner } from "@/components/Spinner";
import { LoadingState } from "@/components/StateField";
import { clientStatusTreatment } from "@/components/status-treatment";
import { createClient, listClients, listPets } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Clients, Pets } from "@/lib/types";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function Roster() {
  useDocumentTitle("Clients");
  const auth = useAuth();
  const navigate = useNavigate();
  const [clients, setClients] = useState<Clients[] | null>(null);
  const [pets, setPets] = useState<Pets[]>([]);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setError(null);
    const [cs, ps] = await Promise.all([listClients(), listPets()]);
    setClients(cs);
    setPets(ps);
  }

  useEffect(() => {
    void load().catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "failed to load"),
    );
  }, []);

  const filtered = useMemo(() => {
    if (!clients) return [];
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    const petOwners = new Set(
      pets.filter((p) => p.name.toLowerCase().includes(q)).map((p) => p.client_id),
    );
    return clients.filter(
      (c) => c.full_name.toLowerCase().includes(q) || petOwners.has(c.id),
    );
  }, [clients, pets, search]);

  async function addClient(e: FormEvent) {
    e.preventDefault();
    if (!auth.operatorId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createClient({
        operator_id: auth.operatorId,
        full_name: newName.trim(),
        email: newEmail.trim() || null,
        phone: newPhone.trim() || null,
      });
      setInviteUrl(`${window.location.origin}/claim/${created.invite_token}`);
      setNewName("");
      setNewEmail("");
      setNewPhone("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not add client");
    } finally {
      setBusy(false);
    }
  }

  if (clients === null) {
    return (
      <div className="page">
        {error
          ? (
            <EmptyState
              tone="attention"
              label="Needs attention"
              title="Couldn't load clients"
              hint={error}
              action={<Button onClick={() => void load().catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load clients."))}>Retry</Button>}
            />
          )
          : <LoadingState label="Loading clients" />}
      </div>
    );
  }

  const petsFor = (clientId: string) =>
    pets.filter((p) => p.client_id === clientId).map((p) => p.name);

  return (
    <div className="page">
      <div className="client-index__header">
        <h1>Clients</h1>
        <div className="client-index__actions">
          <Link className="secondary-link" to="/vault">
            Access vault
          </Link>
          <Button variant="accent" onClick={() => setAddOpen(true)}>
            Add client
          </Button>
        </div>
      </div>

      <div className="client-index__search">
        <Input
          label="Search clients or pets"
          placeholder="Search clients or pets…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="client-list">
        {filtered.length === 0 ? (
          <Card>
            <EmptyState
              title={search ? "No matches" : "No clients yet"}
              hint={search ? "Try a different name." : "Add your first client to get started."}
            />
          </Card>
        ) : (
          filtered.map((c) => {
            const treatment = clientStatusTreatment(c.status);
            return (
              <button
                type="button"
                key={c.id}
                onClick={() => navigate(`/clients/${c.id}`)}
                className="client-row"
                aria-label={`${c.full_name}, ${petsFor(c.id).join(" and ") || "No pets yet"}, ${treatment.label}, ${c.credit_balance} credits`}
              >
                <span className="client-row__identity">
                  <strong>{c.full_name}</strong>
                  <span>
                    {petsFor(c.id).join(" · ") || "No pets yet"}
                  </span>
                </span>
                <span className="client-row__state">
                  <span className="client-row__credits numeral">
                    {c.credit_balance} <span>credits</span>
                  </span>
                  <Badge status={treatment.badge}>{treatment.label}</Badge>
                </span>
              </button>
            );
          })
        )}
      </div>

      <Sheet
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
          setInviteUrl(null);
        }}
        title={inviteUrl ? "Invite link ready" : "Add client"}
      >
        {inviteUrl ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
            <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
              Send this link to your client — it signs them into their portal
              and links their account.
            </p>
            <code
              style={{
                background: "var(--mist)",
                borderRadius: "var(--r-sm)",
                padding: "var(--s-3)",
                fontSize: "var(--fs-12)",
                wordBreak: "break-all",
              }}
            >
              {inviteUrl}
            </code>
            <Button
              full
              onClick={() => {
                void navigator.clipboard.writeText(inviteUrl);
              }}
            >
              Copy link
            </Button>
            <Button variant="ghost" full onClick={() => setInviteUrl(null)}>
              Add another client
            </Button>
          </div>
        ) : (
          <form onSubmit={addClient} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
            <Input label="Full name" required value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Input label="Email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            <Input
              label="Phone"
              type="tel"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              error={error ?? undefined}
            />
            <Button type="submit" full disabled={busy || !newName.trim()}>
              {busy ? <Spinner /> : "Add client"}
            </Button>
          </form>
        )}
      </Sheet>
    </div>
  );
}
