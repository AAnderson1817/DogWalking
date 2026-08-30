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
import { ClientEditSheet } from "@/components/ClientEditSheet";
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
  createSetupCheckout,
  createTopupCheckout,
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
  updateProperty,
  uploadPetPhoto,
  walkPetNames,
  type CredentialMeta,
  type WalkDetailed,
  type ClientRecord,
} from "@/lib/api";
import {
  isEditable,
  propertyFormError,
  propertyFormOf,
  propertyPatch,
} from "@/lib/client-edit";
import { useAuth } from "@/lib/auth-context";
import { compressImage } from "@/lib/image";
import { formatLedgerEntry } from "@/lib/credits";
import { dateLocal, money } from "@/lib/format";
import type { CreditLedger, Operators, Pets, Plans, Properties } from "@/lib/types";
import { useDocumentTitle } from "@/lib/use-document-title";

type Tab = "pets" | "plan" | "walks" | "schedule" | "access";

export default function ClientDetail() {
  useDocumentTitle("Client");
  const auth = useAuth();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [operator, setOperator] = useState<Operators | null>(null);
  const [tab, setTab] = useState<Tab>("pets");
  const [editOpen, setEditOpen] = useState(false);
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
  // One decision, consulted by every surface that writes personal data back
  // into the record. `fn_purge_client` (H5) DELETES pets, REDACTS the property
  // address and access notes and blanks the credential ciphertext while
  // KEEPING those rows — walks still reference them — so "add a pet", "add a
  // property", "edit a property" and "add a secret" each re-personalise an
  // erasure carried out on request, exactly as editing the client would.
  // Guarding only the header, as the first version of this did, made the rule
  // in spec 03 false two tabs over (Codex review, PR #79).
  const editable = isEditable(client);
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
        {/* Withheld from a purged client: `fn_purge_client` (H5) writes the
            tombstone, the UPDATE grant still covers those columns, and nothing
            in the database stops an edit re-personalising an erasure that was
            carried out on request. */}
        {editable && (
          <div className="client-relationship-header__actions">
            <Button variant="ghost" onClick={() => setEditOpen(true)}>
              Edit details
            </Button>
          </div>
        )}
      </header>

      <ClientEditSheet
        // Keyed on the OPEN state as well as the row, so closing remounts and
        // the next open initialises from the record. Without the open flag the
        // sheet is mounted for the life of the screen and `useState(initial)`
        // never re-reads: an operator who typed a wrong address and pressed
        // Escape to abandon it found it still there — and still showing the
        // consequence note — one Save click from being written to the column
        // that decides who may claim the invite. `PropertySheet` below already
        // had this property because its key falls to "closed".
        key={editOpen ? `open:${client.updated_at}` : "closed"}
        open={editOpen}
        client={client}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          void reload();
        }}
      />

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
          {tab === "pets" && <PetsTab clientId={client.id} editable={editable} />}
          {tab === "plan" && operator && (
            <PlanTab client={client} operator={operator} onChanged={() => void reload()} />
          )}
          {tab === "walks" && <WalksTab clientId={client.id} />}
          {tab === "schedule" && <ScheduleTab clientId={client.id} />}
          {tab === "access" && <AccessTab client={client} editable={editable} />}
        </TabPanel>
      </div>
    </div>
  );
}

// ── Pets ───────────────────────────────────────────────────────────────────
function PetsTab({ clientId, editable }: { clientId: string; editable: boolean }) {
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
      {editable && (
        <div>
          <Button variant="accent" onClick={() => setEditing("new")}>Add pet</Button>
        </div>
      )}
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
  client: ClientRecord;
  operator: Operators;
  onChanged: () => void;
}) {
  const [plans, setPlans] = useState<Plans[]>([]);
  const [ledger, setLedger] = useState<CreditLedger[] | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [checkoutPlan, setCheckoutPlan] = useState("");
  const [topupCredits, setTopupCredits] = useState("");
  const [topupDollars, setTopupDollars] = useState("");
  // The pay-per-visit card gets its own error/busy/result state: sharing the
  // Plan card's meant a top-up failure rendered its message inside a
  // DIFFERENT card, and one busy flag spun three unrelated buttons at once.
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [payLink, setPayLink] = useState<{ label: string; url: string } | null>(null);
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

  async function launchTopup() {
    const credits = Number(topupCredits);
    const dollars = Number(topupDollars);
    if (!Number.isInteger(credits) || credits <= 0) {
      setPayError("credits must be a positive whole number");
      return;
    }
    // Validate the ROUNDED cents, not the raw dollars: "0.004" is a positive
    // dollar figure that rounds to zero cents, which the server refuses with
    // developer-facing wording nobody should have to read.
    const pence = Math.round(dollars * 100);
    if (!Number.isFinite(dollars) || pence <= 0) {
      setPayError("enter what the top-up costs in dollars");
      return;
    }
    setPayBusy(true);
    setPayError(null);
    try {
      const { url } = await createTopupCheckout(client.id, credits, pence);
      // window.open with "noopener" returns null even on success, so a
      // blocked popup is indistinguishable from an opened one — the link
      // below is the reliable surface (and what the operator usually needs
      // anyway: something to hand to the client).
      setPayLink({ label: `Top-up checkout for ${credits} credits`, url });
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "top-up checkout failed");
    } finally {
      setPayBusy(false);
    }
  }

  async function launchCardLink() {
    setPayBusy(true);
    setPayError(null);
    try {
      const { url } = await createSetupCheckout(client.id);
      setPayLink({ label: "Card-save link", url });
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "card link failed");
    } finally {
      setPayBusy(false);
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

      {/* The whole card is for clients OUTSIDE a live billing cycle: a plan
          renewal sweeps the balance (fn_apply_rollover, policy 'none' by
          default), so a paid top-up for a subscribed client is money for
          credits the machinery is scheduled to destroy — the server refuses
          it too (409 client_subscribed), and Adjust credits above remains
          the operator-judgment path. */}
      {!subscribed && (
        <Card>
          <span className="section-label">Pay per visit</span>
          <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)", marginTop: "var(--s-1)" }}>
            A client without a plan is charged the service&rsquo;s visit price after
            each completed walk, from the card on file. Credits from a top-up are
            used first.
          </p>
          <div style={{ marginTop: "var(--s-2)", display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            <div className="settings-grid">
              <Input
                label="Top-up credits"
                value={topupCredits}
                onChange={(e) => setTopupCredits(e.target.value)}
                inputMode="numeric"
                placeholder="10"
              />
              <Input
                label="Top-up price ($)"
                value={topupDollars}
                onChange={(e) => setTopupDollars(e.target.value)}
                inputMode="decimal"
                placeholder="200"
              />
            </div>
            <Button
              variant="ghost"
              onClick={() => void launchTopup()}
              disabled={payBusy || !topupCredits.trim() || !topupDollars.trim()}
            >
              {payBusy ? <Spinner /> : "Open top-up checkout"}
            </Button>
            <Button variant="ghost" onClick={() => void launchCardLink()} disabled={payBusy}>
              {payBusy ? <Spinner /> : "Open card-save link"}
            </Button>
            {payLink && (
              <p style={{ fontSize: "var(--fs-14)" }}>
                {payLink.label}:{" "}
                <a href={payLink.url} target="_blank" rel="noreferrer">
                  open or copy this link
                </a>{" "}
                to send to the client.
              </p>
            )}
            <FormError message={payError} />
          </div>
        </Card>
      )}

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
function AccessTab({ client, editable }: { client: ClientRecord; editable: boolean }) {
  const [properties, setProperties] = useState<Properties[] | null>(null);
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  // One piece of state for both shapes, the PetSheet idiom: "new" opens an
  // empty form, a row opens it filled.
  const [editingProp, setEditingProp] = useState<Properties | "new" | null>(null);
  const [addCredFor, setAddCredFor] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [props, creds] = await Promise.all([listProperties(client.id), listCredentials()]);
      setProperties(props);
      setCredentials(creds.filter((c) => props.some((p) => p.id === c.property_id)));
      setLoadError(null);
    } catch (e) {
      // A bare `void load()` after a save meant a successful edit could leave
      // the OLD address on the card with nothing said — so the operator either
      // repeats the edit or, worse, trusts the stale address on their way to
      // the property.
      setLoadError(loadErrorMessage(e));
    }
  }, [client.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (properties === null && loadError) {
    return <LoadError title="Couldn't load properties" message={loadError} onRetry={() => void load()} />;
  }
  if (properties === null) return <LoadingState label="Loading properties" compact />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      <FormError message={loadError} />
      {editable && (
        <div>
          <Button variant="accent" onClick={() => setEditingProp("new")}>Add property</Button>
        </div>
      )}
      {properties.length === 0 ? (
        <Card><EmptyState title="No properties yet" hint="Add where the pets live to store access secrets." /></Card>
      ) : (
        properties.map((property) => (
          <Card key={property.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s-2)" }}>
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
              {editable && (
                <div style={{ display: "flex", gap: "var(--s-1)", flexShrink: 0 }}>
                  {/* Named per property rather than a bare "Edit": this list is
                      several cards long and a screen reader reading the buttons
                      out of context would hear the same word each time. */}
                  <Button
                    variant="ghost"
                    aria-label={`Edit ${property.label}`}
                    onClick={() => setEditingProp(property)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Add secret for ${property.label}`}
                    onClick={() => setAddCredFor(property.id)}
                  >
                    Add secret
                  </Button>
                </div>
              )}
            </div>
            {credentials
              .filter((c) => c.property_id === property.id)
              .map((cred) => (
                <CredentialRow key={cred.id} credential={cred} onChanged={() => void load()} />
              ))}
          </Card>
        ))
      )}

      <PropertySheet
        key={editingProp === "new" ? "new" : editingProp?.id ?? "closed"}
        open={editingProp !== null}
        property={editingProp === "new" ? null : editingProp}
        clientId={client.id}
        onClose={() => setEditingProp(null)}
        onSaved={() => {
          setEditingProp(null);
          void load();
        }}
      />

      <PutCredentialSheet
        // The same remount idiom as the two sheets above, and the reason is
        // sharper here: this form holds a DOOR CODE. Two actions per property
        // card made moving between cards the ordinary flow, so without a key
        // an operator interrupted while entering the lockbox code for one
        // property opens "Add secret" on the next one to find it pre-filled
        // with the first property's secret.
        key={addCredFor ?? "closed"}
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

/**
 * Add and edit in one sheet, keyed by the caller so the form state is rebuilt
 * from props on every open — `useState(initial)` reads its argument once, so a
 * sheet reused across two rows would show the first row's values.
 *
 * `address_line2` is deliberately in neither shape: the create form has never
 * collected it, so no property in the product has one, and offering it on edit
 * alone would make the two forms disagree about what a property is.
 *
 * An earlier version of this comment also claimed the column has no UPDATE
 * grant. That is false — `authenticated` may update it (checked with
 * `has_column_privilege`, which is the authority; `information_schema`
 * .column_privileges, where the claim came from, filters by currently-enabled
 * role and is misleading when read as superuser). The symmetry reason above is
 * the whole reason, and it stands on its own.
 */
function PropertySheet({
  open,
  property,
  clientId,
  onClose,
  onSaved,
}: {
  open: boolean;
  property: Properties | null;
  clientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const auth = useAuth();
  const [form, setForm] = useState(() =>
    property
      ? propertyFormOf(property)
      : { label: "Home", address_line1: "", city: "", postcode: "", access_notes_public: "" },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const invalid = propertyFormError(form);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = propertyFormError(form);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (property) {
        const patch = propertyPatch(property, form);
        if (patch) await updateProperty(property.id, patch);
      } else {
        if (!auth.operatorId) throw new Error("not signed in");
        await createProperty({
          operator_id: auth.operatorId,
          client_id: clientId,
          label: form.label.trim(),
          address_line1: form.address_line1.trim() || null,
          city: form.city.trim() || null,
          postcode: form.postcode.trim() || null,
          access_notes_public: form.access_notes_public.trim() || null,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save the property");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={property ? `Edit ${property.label}` : "Add property"}
    >
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <Input label="Label" required value={form.label} onChange={(e) => set("label", e.target.value)} />
        <Input label="Address" value={form.address_line1} onChange={(e) => set("address_line1", e.target.value)} />
        <Input label="City" value={form.city} onChange={(e) => set("city", e.target.value)} />
        <Input label="Postcode" value={form.postcode} onChange={(e) => set("postcode", e.target.value)} />
        <Textarea
          label="Public access notes (non-secret)"
          placeholder="Gate sticks — lift while pushing."
          value={form.access_notes_public}
          onChange={(e) => set("access_notes_public", e.target.value)}
        />
        <FormError message={error} />
        <Button type="submit" full disabled={busy || invalid !== null}>
          {busy ? <Spinner /> : property ? "Save changes" : "Save property"}
        </Button>
      </form>
    </Sheet>
  );
}
