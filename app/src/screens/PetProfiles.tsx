// PetProfiles (phase 07): the client persona self-manages care fields
// (temperament, feeding, medical, medication, vet, photo — spec 03 column
// grants) and each property's public access notes. Secret codes are
// operator-entered by design.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Input, Textarea } from "@/components/fields";
import { Sheet } from "@/components/Sheet";
import { Spinner } from "@/components/Spinner";
import {
  getMyClient,
  listPets,
  listProperties,
  signedPetPhotoUrl,
  updatePet,
  updateProperty,
  uploadPetPhoto,
} from "@/lib/api";
import { compressImage } from "@/lib/image";
import type { Clients, Pets, Properties } from "@/lib/types";

export default function PetProfiles() {
  const [client, setClient] = useState<Clients | null>(null);
  const [pets, setPets] = useState<Pets[]>([]);
  const [properties, setProperties] = useState<Properties[]>([]);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [editingPet, setEditingPet] = useState<Pets | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const me = await getMyClient();
    if (!me) return;
    const [ps, props] = await Promise.all([listPets(me.id), listProperties(me.id)]);
    setClient(me);
    setPets(ps);
    setProperties(props);
    const urls: Record<string, string> = {};
    await Promise.all(
      ps.filter((p) => p.photo_path).map(async (p) => {
        try {
          urls[p.id] = await signedPetPhotoUrl(p.photo_path!);
        } catch {
          // photo missing — render the initial instead
        }
      }),
    );
    setPhotoUrls(urls);
  }, []);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  if (loading || !client) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Your pets</h1>

      <div style={{ marginTop: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        {pets.length === 0 ? (
          <Card><EmptyState title="No pets on file" hint="Your walker adds pets to your account." /></Card>
        ) : (
          pets.map((pet) => (
            <Card key={pet.id} onClick={() => setEditingPet(pet)} style={{ cursor: "pointer", display: "flex", gap: "var(--s-3)", alignItems: "center" }}>
              {photoUrls[pet.id] ? (
                <img
                  src={photoUrls[pet.id]}
                  alt={pet.name}
                  style={{ width: 56, height: 56, borderRadius: "var(--r-full)", objectFit: "cover" }}
                />
              ) : (
                <span className="pet-avatar" style={{ width: 56, height: 56, fontSize: "var(--fs-20)" }}>
                  {pet.name.charAt(0)}
                </span>
              )}
              <div>
                <div style={{ fontWeight: 600 }}>{pet.name}</div>
                <div style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
                  {pet.temperament ?? "Tap to add care notes"}
                </div>
              </div>
            </Card>
          ))
        )}
      </div>

      <section style={{ marginTop: "var(--s-6)" }}>
        <span className="section-label">Home access notes</span>
        <p style={{ color: "var(--text-2)", fontSize: "var(--fs-12)", marginTop: "var(--s-1)" }}>
          Anything non-secret your walker should know. Door codes, alarm
          sequences and key locations are stored by your walker in the
          encrypted vault — share those directly, never here.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
          {properties.map((property) => (
            <PropertyNotesCard key={property.id} property={property} onSaved={() => void load()} />
          ))}
        </div>
      </section>

      {editingPet && (
        <PetCareSheet
          pet={editingPet}
          operatorId={client.operator_id}
          onClose={() => setEditingPet(null)}
          onSaved={() => {
            setEditingPet(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function PropertyNotesCard({ property, onSaved }: { property: Properties; onSaved: () => void }) {
  const [notes, setNotes] = useState(property.access_notes_public ?? "");
  const [busy, setBusy] = useState(false);
  const dirty = notes !== (property.access_notes_public ?? "");

  async function save() {
    setBusy(true);
    try {
      await updateProperty(property.id, { access_notes_public: notes.trim() || null });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div style={{ fontWeight: 600 }}>{property.label}</div>
      <div style={{ marginTop: "var(--s-2)" }}>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Gate sticks — lift while pushing." />
      </div>
      {dirty && (
        <div style={{ marginTop: "var(--s-2)" }}>
          <Button variant="ghost" onClick={() => void save()} disabled={busy}>
            {busy ? <Spinner /> : "Save notes"}
          </Button>
        </div>
      )}
    </Card>
  );
}

function PetCareSheet({
  pet,
  operatorId,
  onClose,
  onSaved,
}: {
  pet: Pets;
  operatorId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    temperament: pet.temperament ?? "",
    feeding_notes: pet.feeding_notes ?? "",
    medical_notes: pet.medical_notes ?? "",
    medication_notes: pet.medication_notes ?? "",
    vet_name: pet.vet_name ?? "",
    vet_phone: pet.vet_phone ?? "",
  });
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const patch: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(form)) patch[k] = v.trim() || null;
      if (photo) {
        const compressed = await compressImage(photo);
        patch.photo_path = await uploadPetPhoto(operatorId, pet.id, compressed);
      }
      await updatePet(pet.id, patch);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={`${pet.name} — care notes`}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <Textarea label="Temperament" value={form.temperament} onChange={(e) => set("temperament", e.target.value)} />
        <Textarea label="Feeding" value={form.feeding_notes} onChange={(e) => set("feeding_notes", e.target.value)} />
        <Textarea label="Medical" value={form.medical_notes} onChange={(e) => set("medical_notes", e.target.value)} />
        <Input label="Medication" value={form.medication_notes} onChange={(e) => set("medication_notes", e.target.value)} />
        <Input label="Vet name" value={form.vet_name} onChange={(e) => set("vet_name", e.target.value)} />
        <Input label="Vet phone" value={form.vet_phone} onChange={(e) => set("vet_phone", e.target.value)} />
        <label className="field">
          <span className="field__label">Photo</span>
          <input type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </label>
        {error && <span className="field__error">{error}</span>}
        <Button type="submit" full disabled={busy}>
          {busy ? <Spinner /> : "Save"}
        </Button>
      </form>
    </Sheet>
  );
}
