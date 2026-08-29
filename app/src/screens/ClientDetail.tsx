// ClientDetail (phase 05): tabs Pets · Plan & credits · Walks · Access.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { CreditMeter } from "@/components/CreditMeter";
import { EmptyState } from "@/components/EmptyState";
import { FormError, Input, Select, Textarea } from "@/components/fields";
import { LoadError, loadErrorMessage } from "@/components/LoadError";
import { ClientDataPanel } from "@/components/ClientDataPanel";
import { InvitePanel } from "@/components/InvitePanel";
import { SegmentedTabs, TabPanel } from "@/components/SegmentedTabs";
import { Sheet } from "@/components/Sheet";
import { Spinner } from "@/components/Spinner";
import { LoadingState, StateField } from "@/components/StateField";
import {
  clientStatusTreatment,
  subscriptionStatusTreatment,
} from "@/components/status-treatment";
import { WalkCard } from "@/components/WalkCard";
import { CredentialRow, PutCredentialSheet } from "@/components/VaultFlows";
import { ScheduleTab } from "@/components/ScheduleEditor";
import {
  adjustCredits,
  createCheckout,
  createPet,
  createProperty,
  getClient,
  getMyOperator,
  isNotFound,
  listCredentials,
  listLedger,
  listPets,
  listPlans,
  listProperties,
  listWalksDetailed,
  updatePet,
  uploadPetPhoto,
  walkPetNames,
  type CredentialMeta,
  type WalkDetailed,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { compressImage } from "@/lib/image";
import { formatLedgerEntry } from "@/lib/credits";
import { dateLocal, money } from "@/lib/format";
import type { Clients, CreditLedger, Operators, Pets, Plans, Properties } from "@/lib/types";
import { useDocumentTitle } from "@/lib/use-document-title";

type Tab = "pets" | "plan" | "walks" | "schedule" | "access";

export default function ClientDetail() {
  useDocumentTitle("Client");
  const auth = useAuth();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [client, setClient] = useState<Clients | null>(null);
  const [operator, setOperator] = useState<Operators | null>(null);
  const [tab, setTab] = useState<Tab>("pets");
  const [error, setError] = useState<string | null>(null);
  // Distinguished from `error` on purpose: "this client does not exist" and
  // "we could not reach the server" need different screens, and conflating
  // them is the whole of review M39.
  const [missing, setMissing] = useState(false);

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      const [c, op] = await Promise.all([getClient(id), getMyOperator(auth.session?.user.id)]);
      setClient(c);
      setOperator(op);
      setError(null);
      setMissing(false);
    } catch (e) {
      // Review M39. This screen is the destination of the Clients tab, and it
      // used to render "Client not found" for EVERY failure with the raw error
      // as the hint and no retry — so an operator on a weak connection outside
      // a client's door was told the client did not exist, under a string like
      // "JWT expired". PGRST116 is PostgREST's "no rows for a .single()",
      // which is the only failure that actually means not found.
      setMissing(isNotFound(e));
      setError(loadErrorMessage(e));
    }
  }, [id, auth.session?.user.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error && missing) {
    return (
      <div className="page">
        <Card>
          <EmptyState
            title="Client not found"
            hint="This client may have been removed."
            action={<Button variant="ghost" onClick={() => navigate("/roster")}>Back to clients</Button>}
          />
        </Card>
      </div>
    );
  }
  if (error) {
    return <LoadError title="Couldn't load this client" message={error} onRetry={() => reload()} />;
  }
  if (!client) {
    return (
      <div className="page">
        <LoadingState label="Loading client details" />
      </div>
    );
  }

  const TABS: Array<{ key: Tab; label: string }> = [
    { key: "pets", label: "Pets" },
    { key: "plan", label: "Plan & credits" },
    { key: "walks", label: "Walks" },
    { key: "schedule", label: "Schedule" },
    { key: "access", label: "Access" },
  ];
  const clientTreatment = clientStatusTreatment(client.status);

  return (
    <div className="page">
      <header className="client-relationship-header">
        <span className="section-label">Client</span>
        <div className="client-relationship-header__title">
          <h1>{client.full_name}</h1>
          <span className="client-relationship-header__credits numeral" title="Credit balance">
            {client.credit_balance} <span>credits</span>
          </span>
        </div>
        <div className="client-relationship-header__meta">
          <span>{client.email ?? "No email"}</span>
          <span>{client.phone ?? "No phone"}</span>
          <Badge status={clientTreatment.badge}>{clientTreatment.label}</Badge>
        </div>
      </header>

      {/* Review H4: the operator's only way to reissue or withdraw an invite.
          Renders nothing once the client has claimed. */}
      <InvitePanel client={client} onChanged={() => void reload()} />

      {/* Review H5: export and erasure. Sits below the tabs rather than inside
          one, because it is about the whole record rather than a section of
          it — and it must not be somewhere an operator lands by accident. */}
      <ClientDataPanel client={client} onPurged={() => void reload()} />

      {/* Review M16. This control had no `aria-label` at all, so a screen
          reader announced "tab, 5 of 5, selected" for the operator's main
          client workspace with nothing saying what the tabs were for — and
          the fifth of them is the credential vault. */}
      <SegmentedTabs
        idBase="client"
        label="Client sections"
        tabs={TABS}
        value={tab}
        onChange={setTab}
        style={{ marginTop: "var(--s-4)" }}
      />

      <div style={{ marginTop: "var(--s-4)" }}>
        <TabPanel idBase="client" tabKey={tab}>
          {tab === "pets" && <PetsTab clientId={client.id} />}
          {tab === "plan" && operator && (
            <PlanTab client={client} operator={operator} onChanged={() => void reload()} />
          )}
          {tab === "walks" && <WalksTab clientId={client.id} />}
          {tab === "schedule" && <ScheduleTab clientId={client.id} />}
          {tab === "access" && <AccessTab client={client} />}
        </TabPanel>
      </div>
    </div>
  );
}

// ── Pets ───────────────────────────────────────────────────────────────────
function PetsTab({ clientId }: { clientId: string }) {
  const auth = useAuth();
  const [pets, setPets] = useState<Pets[] | null>(null);
  const [editing, setEditing] = useState<Pets | "new" | null>(null);

  const load = useCallback(async () => setPets(await listPets(clientId)), [clientId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (pets === null) return <LoadingState label="Loading pets" compact />;

  return (
    <div className="pet-profile-list">
      <div>
        <Button variant="accent" onClick={() => setEditing("new")}>Add pet</Button>
      </div>
      {pets.length === 0 ? (
        <Card><EmptyState title="No pets yet" /></Card>
      ) : (
        pets.map((pet) => (
          <button key={pet.id} type="button" onClick={() => setEditing(pet)} className="pet-profile-row">
            <span className="pet-profile-row__identity">
                <strong>{pet.name}</strong>
                <span>
                  {[pet.breed, pet.size].filter(Boolean).join(" · ") || "—"}
                </span>
            </span>
            <span className="pet-profile-row__flags">
                {pet.is_reactive && <Badge status="attention">Reactive</Badge>}
                {pet.is_escape_risk && <Badge status="attention">Escape risk</Badge>}
            </span>
            {(pet.temperament || pet.feeding_notes) && (
              <span className="pet-profile-row__note">
                {pet.temperament ?? pet.feeding_notes}
              </span>
            )}
          </button>
        ))
      )}
      <PetSheet
        key={editing === "new" ? "new" : editing?.id ?? "closed"}
        open={editing !== null}
        pet={editing === "new" ? null : editing}
        clientId={clientId}
        operatorId={auth.operatorId ?? ""}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}

function PetSheet({
  open,
  pet,
  clientId,
  operatorId,
  onClose,
  onSaved,
}: {
  open: boolean;
  pet: Pets | null;
  clientId: string;
  operatorId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: pet?.name ?? "",
    breed: pet?.breed ?? "",
    size: pet?.size ?? "medium",
    temperament: pet?.temperament ?? "",
    feeding_notes: pet?.feeding_notes ?? "",
    medical_notes: pet?.medical_notes ?? "",
    medication_notes: pet?.medication_notes ?? "",
    vet_name: pet?.vet_name ?? "",
    vet_phone: pet?.vet_phone ?? "",
    is_reactive: pet?.is_reactive ?? false,
    is_escape_risk: pet?.is_escape_risk ?? false,
  });
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let photo_path: string | undefined;
      const base = {
        name: form.name.trim(),
        breed: form.breed.trim() || null,
        size: form.size as Pets["size"],
        temperament: form.temperament.trim() || null,
        feeding_notes: form.feeding_notes.trim() || null,
        medical_notes: form.medical_notes.trim() || null,
        medication_notes: form.medication_notes.trim() || null,
        vet_name: form.vet_name.trim() || null,
        vet_phone: form.vet_phone.trim() || null,
        is_reactive: form.is_reactive,
        is_escape_risk: form.is_escape_risk,
      };
      const saved = pet
        ? await updatePet(pet.id, base)
        : await createPet({ ...base, operator_id: operatorId, client_id: clientId });
      if (photo) {
        const compressed = await compressImage(photo);
        photo_path = await uploadPetPhoto(operatorId, saved.id, compressed);
        await updatePet(saved.id, { photo_path });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save pet");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={pet ? `Edit ${pet.name}` : "Add pet"}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <Input label="Name" required value={form.name} onChange={(e) => set("name", e.target.value)} />
        <Input label="Breed" value={form.breed} onChange={(e) => set("breed", e.target.value)} />
        <Select label="Size" value={form.size ?? "medium"} onChange={(e) => set("size", e.target.value)}>
          <option value="small">Small</option>
          <option value="medium">Medium</option>
          <option value="large">Large</option>
          <option value="giant">Giant</option>
        </Select>
        <Textarea label="Temperament" value={form.temperament} onChange={(e) => set("temperament", e.target.value)} />
        <Textarea label="Feeding notes" value={form.feeding_notes} onChange={(e) => set("feeding_notes", e.target.value)} />
        <Textarea label="Medical notes" value={form.medical_notes} onChange={(e) => set("medical_notes", e.target.value)} />
        <Input label="Medication" value={form.medication_notes} onChange={(e) => set("medication_notes", e.target.value)} />
        <Input label="Vet name" value={form.vet_name} onChange={(e) => set("vet_name", e.target.value)} />
        <Input label="Vet phone" value={form.vet_phone} onChange={(e) => set("vet_phone", e.target.value)} />
        <label style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
          <input type="checkbox" checked={form.is_reactive} onChange={(e) => set("is_reactive", e.target.checked)} />
          Reactive with other dogs
        </label>
        <label style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
          <input type="checkbox" checked={form.is_escape_risk} onChange={(e) => set("is_escape_risk", e.target.checked)} />
          Escape risk
        </label>
        <label className="field">
          <span className="field__label">Photo</span>
          <input type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </label>
        <FormError message={error} />
        <Button type="submit" full disabled={busy || !form.name.trim()}>
          {busy ? <Spinner /> : "Save pet"}
        </Button>
      </form>
    </Sheet>
  );
}

// ── Plan & credits ─────────────────────────────────────────────────────────
function PlanTab({
  client,
  operator,
  onChanged,
}: {
  client: Clients;
  operator: Operators;
  onChanged: () => void;
}) {
  const [plans, setPlans] = useState<Plans[]>([]);
  const [ledger, setLedger] = useState<CreditLedger[] | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [checkoutPlan, setCheckoutPlan] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [ps, lg] = await Promise.all([listPlans(), listLedger(client.id)]);
    setPlans(ps);
    setLedger(lg);
    setCheckoutPlan((prev) => prev || (ps[0]?.id ?? ""));
  }, [client.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const plan = plans.find((p) => p.id === client.plan_id) ?? null;
  // past_due counts as subscribed. It was excluded, which meant a client whose
  // card had merely failed was offered "Launch Stripe checkout" — starting a
  // SECOND live subscription on the same customer, two invoice.paid events
  // with different invoice ids, and two cycle grants. The subscription still
  // exists; it is the payment that failed.
  const subscribed = client.subscription_status === "active"
    || client.subscription_status === "paused"
    || client.subscription_status === "past_due";
  const subscriptionTreatment = subscriptionStatusTreatment(client.subscription_status);

  async function submitAdjust(e: FormEvent) {
    e.preventDefault();
    const n = Number(amount);
    if (!Number.isInteger(n) || n === 0) {
      setError("amount must be a non-zero whole number");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adjustCredits(client.id, n, note.trim());
      setAdjustOpen(false);
      setAmount("");
      setNote("");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "adjustment failed");
    } finally {
      setBusy(false);
    }
  }

  async function launchCheckout() {
    if (!checkoutPlan) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await createCheckout(client.id, checkoutPlan);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : "checkout failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      <Card>
        <CreditMeter
          balance={client.credit_balance}
          threshold={operator.low_credit_threshold}
          cycleCredits={plan?.credits_per_cycle}
        />
        <div style={{ marginTop: "var(--s-3)" }}>
          <Button variant="ghost" onClick={() => setAdjustOpen(true)}>Adjust credits</Button>
        </div>
      </Card>

      <Card>
        <span className="section-label">Plan</span>
        {plan ? (
          <div style={{ marginTop: "var(--s-2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontWeight: 600 }}>{plan.name}</span>
              <span className="numeral" style={{ fontWeight: 600 }}>{money(plan.price_pence)}/{plan.cycle}</span>
            </div>
            <div style={{ color: "var(--text-2)", fontSize: "var(--fs-14)", marginTop: "var(--s-1)" }}>
              {plan.credits_per_cycle} credits per cycle · overage {money(plan.overage_rate_pence)} ·{" "}
              rollover {plan.rollover_policy}
              {plan.rollover_policy === "capped" ? ` (cap ${plan.rollover_cap})` : ""}
            </div>
            <div style={{ marginTop: "var(--s-2)" }}>
              <Badge status={subscriptionTreatment.badge}>
                {subscriptionTreatment.label}
              </Badge>
            </div>
          </div>
        ) : (
          <StateField compact title="No plan yet" detail="Choose a plan to start a subscription." />
        )}

        {!subscribed && plans.length > 0 && (
          <div style={{ marginTop: "var(--s-3)", display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            <Select label="Subscribe to" value={checkoutPlan} onChange={(e) => setCheckoutPlan(e.target.value)}>
              {plans.filter((p) => p.active).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {money(p.price_pence)}/{p.cycle}
                </option>
              ))}
            </Select>
            <Button onClick={() => void launchCheckout()} disabled={busy}>
              {busy ? <Spinner /> : "Launch Stripe checkout"}
            </Button>
          </div>
        )}
        <FormError message={error} />
      </Card>

      <Card>
        <span className="section-label">Ledger</span>
        {ledger === null ? (
          <LoadingState label="Loading credit history" compact />
        ) : ledger.length === 0 ? (
          <StateField compact title="No credit activity yet" />
        ) : (
          <table className="ledger-table">
            <tbody>
              {ledger.map((entry) => {
                const line = formatLedgerEntry(entry);
                return (
                  <tr key={entry.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{line.label}</div>
                      <div style={{ color: "var(--text-2)", fontSize: "var(--fs-12)" }}>
                        {dateLocal(line.createdAt)}{line.note ? ` · ${line.note}` : ""}
                      </div>
                    </td>
                    <td className="numeral" style={{ textAlign: "right", fontWeight: 600 }}>{line.amount}</td>
                    <td className="numeral" style={{ textAlign: "right", color: "var(--text-2)", paddingLeft: "var(--s-3)" }}>
                      {line.balanceAfter}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Sheet open={adjustOpen} onClose={() => setAdjustOpen(false)} title="Adjust credits">
        <form onSubmit={submitAdjust} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          <Input
            label="Amount (± whole credits)"
            required
            inputMode="numeric"
            placeholder="+2 or -1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Input
            label="Note"
            required
            placeholder="Top-up paid in cash"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            error={error ?? undefined}
          />
          <Button type="submit" full disabled={busy || !note.trim()}>
            {busy ? <Spinner /> : "Apply adjustment"}
          </Button>
        </form>
      </Sheet>
    </div>
  );
}

// ── Walks ──────────────────────────────────────────────────────────────────
function WalksTab({ clientId }: { clientId: string }) {
  const navigate = useNavigate();
  const [walks, setWalks] = useState<WalkDetailed[] | null>(null);

  useEffect(() => {
    void listWalksDetailed({ clientId }).then((ws) =>
      setWalks([...ws].sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))),
    );
  }, [clientId]);

  if (walks === null) return <LoadingState label="Loading walks" compact />;
  if (walks.length === 0) return <Card><EmptyState title="No walks yet" /></Card>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
      {walks.map((w) => (
        <div key={w.id}>
          <span className="section-label">{dateLocal(`${w.scheduled_date}T12:00:00Z`)}</span>
          <WalkCard
            walk={{
              windowStart: w.window_start,
              windowEnd: w.window_end,
              petNames: walkPetNames(w),
              propertyLabel: w.property?.label ?? "",
              status: w.status,
              isOverage: w.is_overage,
            }}
            onClick={() => navigate(`/walks/${w.id}/live`)}
          />
        </div>
      ))}
    </div>
  );
}

// ── Access ─────────────────────────────────────────────────────────────────
function AccessTab({ client }: { client: Clients }) {
  const auth = useAuth();
  const [properties, setProperties] = useState<Properties[] | null>(null);
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  const [addPropOpen, setAddPropOpen] = useState(false);
  const [addCredFor, setAddCredFor] = useState<string | null>(null);
  const [label, setLabel] = useState("Home");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [postcode, setPostcode] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [props, creds] = await Promise.all([listProperties(client.id), listCredentials()]);
    setProperties(props);
    setCredentials(creds.filter((c) => props.some((p) => p.id === c.property_id)));
  }, [client.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addProperty(e: FormEvent) {
    e.preventDefault();
    if (!auth.operatorId) return;
    setBusy(true);
    setError(null);
    try {
      await createProperty({
        operator_id: auth.operatorId,
        client_id: client.id,
        label: label.trim(),
        address_line1: address.trim() || null,
        city: city.trim() || null,
        postcode: postcode.trim() || null,
        access_notes_public: notes.trim() || null,
      });
      setAddPropOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not add the property");
    } finally {
      setBusy(false);
    }
  }

  if (properties === null) return <LoadingState label="Loading properties" compact />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      <div>
        <Button variant="accent" onClick={() => setAddPropOpen(true)}>Add property</Button>
      </div>
      {properties.length === 0 ? (
        <Card><EmptyState title="No properties yet" hint="Add where the pets live to store access secrets." /></Card>
      ) : (
        properties.map((property) => (
          <Card key={property.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{property.label}</div>
                <div style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
                  {[property.address_line1, property.city, property.postcode].filter(Boolean).join(", ")}
                </div>
                {property.access_notes_public && (
                  <div style={{ color: "var(--text-2)", fontSize: "var(--fs-12)", marginTop: "var(--s-1)" }}>
                    {property.access_notes_public}
                  </div>
                )}
              </div>
              <Button variant="ghost" onClick={() => setAddCredFor(property.id)}>Add secret</Button>
            </div>
            {credentials
              .filter((c) => c.property_id === property.id)
              .map((cred) => (
                <CredentialRow key={cred.id} credential={cred} onChanged={() => void load()} />
              ))}
          </Card>
        ))
      )}

      <Sheet open={addPropOpen} onClose={() => setAddPropOpen(false)} title="Add property">
        <form onSubmit={addProperty} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          <Input label="Label" required value={label} onChange={(e) => setLabel(e.target.value)} />
          <Input label="Address" value={address} onChange={(e) => setAddress(e.target.value)} />
          <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} />
          <Input label="Postcode" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
          <Textarea
            label="Public access notes (non-secret)"
            placeholder="Gate sticks — lift while pushing."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <FormError message={error} />
          <Button type="submit" full disabled={busy || !label.trim()}>
            {busy ? <Spinner /> : "Save property"}
          </Button>
        </form>
      </Sheet>

      <PutCredentialSheet
        open={addCredFor !== null}
        onClose={() => setAddCredFor(null)}
        propertyId={addCredFor ?? undefined}
        onSaved={() => {
          setAddCredFor(null);
          void load();
        }}
      />
    </div>
  );
}
