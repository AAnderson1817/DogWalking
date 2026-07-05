// Roster (phase 05): searchable client list (by name or pet), status
// badges, balance chips → ClientDetail. Includes add-client with invite
// link handoff.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, type BadgeStatus } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/fields";
import { Sheet } from "@/components/Sheet";
import { Spinner } from "@/components/Spinner";
import { createClient, listClients, listPets } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { Clients, Pets } from "@/lib/types";

const STATUS_BADGE: Record<Clients["status"], BadgeStatus> = {
  invited: "neutral",
  active: "completed",
  paused: "warn",
  archived: "cancelled",
};

export default function Roster() {
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
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : <Spinner />}
      </div>
    );
  }

  const petsFor = (clientId: string) =>
    pets.filter((p) => p.client_id === clientId).map((p) => p.name);

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Roster</h1>
        <Button variant="accent" onClick={() => setAddOpen(true)}>
          Add client
        </Button>
      </div>

      <div style={{ marginTop: "var(--s-3)" }}>
        <Input
          placeholder="Search clients or pets…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search"
        />
      </div>

      <div style={{ marginTop: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
        {filtered.length === 0 ? (
          <Card>
            <EmptyState
              title={search ? "No matches" : "No clients yet"}
              hint={search ? "Try a different name." : "Add your first client to get started."}
            />
          </Card>
        ) : (
          filtered.map((c) => (
            <Card
              key={c.id}
              onClick={() => navigate(`/clients/${c.id}`)}
              style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s-2)" }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{c.full_name}</div>
                <div style={{ color: "var(--text-2)", fontSize: "var(--fs-14)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {petsFor(c.id).join(" · ") || "No pets yet"}
                </div>
              </div>
              <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center", flexShrink: 0 }}>
                <span className="numeral" style={{ fontWeight: 700 }} title="Credit balance">
                  {c.credit_balance}
                </span>
                <Badge status={STATUS_BADGE[c.status]}>{c.status}</Badge>
              </div>
            </Card>
          ))
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
