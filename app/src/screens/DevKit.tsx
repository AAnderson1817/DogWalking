// /dev/kit — dev-build-only component gallery (phase 03): every component
// in every state with fixture data. Excluded from the production bundle by
// the import.meta.env.DEV guard in App.tsx.
import { useState } from "react";
import { Badge, type BadgeStatus } from "@/components/Badge";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { CreditMeter } from "@/components/CreditMeter";
import { EmptyState } from "@/components/EmptyState";
import { Input, Select, Textarea } from "@/components/fields";
import { LiveWalkBanner } from "@/components/LiveWalkBanner";
import { MapView } from "@/components/MapView";
import { ReportCard } from "@/components/ReportCard";
import { Sheet } from "@/components/Sheet";
import { Spinner } from "@/components/Spinner";
import { WalkCard } from "@/components/WalkCard";

const ROUTE = [
  { lat: 51.4419, lng: -0.0533 },
  { lat: 51.4424, lng: -0.0527 },
  { lat: 51.4429, lng: -0.052 },
  { lat: 51.4431, lng: -0.051 },
  { lat: 51.4427, lng: -0.0503 },
  { lat: 51.442, lng: -0.0508 },
];

const BADGES: BadgeStatus[] = [
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
  "overage",
  "warn",
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: "var(--s-6)" }}>
      <span className="section-label">{title}</span>
      <div style={{ marginTop: "var(--s-2)", display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        {children}
      </div>
    </section>
  );
}

export default function DevKit() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [banner, setBanner] = useState(false);
  const [walkmode, setWalkmode] = useState(false);

  return (
    <div className={walkmode ? "walkmode" : undefined} style={{ background: "var(--bg)", minHeight: "100dvh" }}>
      <div className="page">
        <h1>Component kit</h1>
        <p style={{ color: "var(--text-2)" }}>Every component, every state, fixture data.</p>

        <Section title="Buttons">
          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            <Button>Primary</Button>
            <Button variant="accent">Accent</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button disabled>Disabled</Button>
          </div>
          <Button full>Full width</Button>
        </Section>

        <Section title="Fields">
          <Input label="Client name" placeholder="Amelia Hart" />
          <Input label="With error" defaultValue="bad@" error="That doesn't look like an email" />
          <Textarea label="Notes" placeholder="Gate sticks — lift while pushing." />
          <Select label="Service">
            <option>Private walk 30</option>
            <option>Private walk 60</option>
          </Select>
        </Section>

        <Section title="Badges">
          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            {BADGES.map((s) => (
              <Badge key={s} status={s} />
            ))}
          </div>
        </Section>

        <Section title="CreditMeter">
          <Card>
            <CreditMeter balance={7} threshold={2} cycleCredits={10} />
          </Card>
          <Card>
            <CreditMeter balance={1} threshold={2} cycleCredits={10} label="Low (amber)" />
          </Card>
        </Section>

        <Section title="WalkCard">
          <WalkCard
            walk={{
              windowStart: "12:00:00",
              windowEnd: "13:00:00",
              petNames: ["Biscuit", "Pickle"],
              propertyLabel: "Home",
              status: "scheduled",
              clientName: "Amelia Hart",
            }}
          />
          <WalkCard
            walk={{
              windowStart: "15:00:00",
              windowEnd: "16:00:00",
              petNames: ["Nova"],
              propertyLabel: "Flat",
              status: "in_progress",
            }}
          />
          <WalkCard
            walk={{
              windowStart: "09:00:00",
              windowEnd: "10:00:00",
              petNames: ["Biscuit"],
              propertyLabel: "Home",
              status: "completed",
              isOverage: true,
            }}
          />
        </Section>

        <Section title="MapView (SVG fallback without token / live)">
          <MapView points={ROUTE} />
          <MapView points={ROUTE} live />
          <MapView points={[]} />
        </Section>

        <Section title="ReportCard">
          <ReportCard
            report={{
              photoUrls: [],
              routePoints: ROUTE,
              distanceM: 2140,
              pottyPee: true,
              pottyPoo: true,
              fed: true,
              watered: false,
              notes: "Lovely loop of the park; Biscuit met a labrador friend.",
              petNames: ["Biscuit", "Pickle"],
            }}
          />
        </Section>

        <Section title="Spinner + EmptyState">
          <Spinner />
          <Card>
            <EmptyState
              title="No walks today"
              hint="Scheduled walks appear here in route order."
              action={<Button variant="ghost">Add a walk</Button>}
            />
          </Card>
        </Section>

        <Section title="Overlays & modes">
          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            <Button variant="ghost" onClick={() => setSheetOpen(true)}>Open Sheet</Button>
            <Button variant="ghost" onClick={() => setBanner((b) => !b)}>Toggle LiveWalkBanner</Button>
            <Button variant="ghost" onClick={() => setWalkmode((w) => !w)}>Toggle .walkmode</Button>
          </div>
          <div className="numeral" style={{ fontSize: "var(--fs-32)" }}>
            12:34 · 2.1 km
          </div>
        </Section>

        <Section title="BottomNav (portal variant below)">
          <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
            Fixed to the viewport bottom; operator variant becomes a left rail ≥1024px.
          </p>
        </Section>
      </div>

      {banner && (
        <LiveWalkBanner
          walkId="fixture"
          startedAt={new Date(Date.now() - 754000).toISOString()}
          label="Walking Biscuit & Pickle"
        />
      )}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Confirm password">
        <Input label="Password" type="password" placeholder="••••••••" />
        <div style={{ marginTop: "var(--s-4)" }}>
          <Button full onClick={() => setSheetOpen(false)}>Confirm</Button>
        </div>
      </Sheet>
      <BottomNav persona="client" />
    </div>
  );
}
