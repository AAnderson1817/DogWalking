// Access Vault (phase 05): global credential list grouped by client and
// property; reveal / rotate / revoke / audit via the shared vault flows.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Spinner } from "@/components/Spinner";
import { CredentialRow, PutCredentialSheet } from "@/components/VaultFlows";
import { listClients, listCredentials, listProperties, type CredentialMeta } from "@/lib/api";
import type { Clients, Properties } from "@/lib/types";

export default function AccessVault() {
  const [credentials, setCredentials] = useState<CredentialMeta[] | null>(null);
  const [properties, setProperties] = useState<Properties[]>([]);
  const [clients, setClients] = useState<Clients[]>([]);
  const [addFor, setAddFor] = useState<string | null>(null); // property id
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [creds, props, cs] = await Promise.all([
        listCredentials(),
        listProperties(),
        listClients(),
      ]);
      setCredentials(creds);
      setProperties(props);
      setClients(cs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="page">
        <h1>Access Vault</h1>
        <Card style={{ marginTop: "var(--s-4)" }}>
          <EmptyState title="Couldn't load the vault" hint={error} />
        </Card>
      </div>
    );
  }
  if (credentials === null) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  }

  const clientName = (id: string) => clients.find((c) => c.id === id)?.full_name ?? "";
  const byProperty = (propertyId: string) => credentials.filter((c) => c.property_id === propertyId);

  return (
    <div className="page">
      <h1>Access Vault</h1>
      <p style={{ color: "var(--text-2)", marginTop: "var(--s-1)", fontSize: "var(--fs-14)" }}>
        Every reveal requires your password and a purpose, and is written to
        the audit trail.
      </p>

      <div style={{ marginTop: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        {properties.length === 0 ? (
          <Card>
            <EmptyState
              title="No properties yet"
              hint="Add a property from a client's Access tab, then store its secrets here."
            />
          </Card>
        ) : (
          properties.map((property) => (
            <Card key={property.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span className="section-label">{clientName(property.client_id)}</span>
                  <h2 style={{ fontSize: "var(--fs-20)" }}>{property.label}</h2>
                </div>
                <Button variant="ghost" onClick={() => setAddFor(property.id)}>
                  Add secret
                </Button>
              </div>
              {byProperty(property.id).length === 0 ? (
                <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)", marginTop: "var(--s-2)" }}>
                  No credentials stored.
                </p>
              ) : (
                byProperty(property.id).map((cred) => (
                  <CredentialRow key={cred.id} credential={cred} onChanged={() => void load()} />
                ))
              )}
            </Card>
          ))
        )}
      </div>

      <PutCredentialSheet
        open={addFor !== null}
        onClose={() => setAddFor(null)}
        propertyId={addFor ?? undefined}
        onSaved={() => {
          setAddFor(null);
          void load();
        }}
      />
    </div>
  );
}
