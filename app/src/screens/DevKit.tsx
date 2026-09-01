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
import { MapView } from "@/components/MapView";
import { MoneyValueRail } from "@/components/MoneyValueRail";
import { NotificationList } from "@/components/NotificationInbox";
import { PaymentRow } from "@/components/PaymentRow";
import { ReportCard } from "@/components/ReportCard";
import { Sheet } from "@/components/Sheet";
import { LoadingState, StateField } from "@/components/StateField";
import { WalkCard } from "@/components/WalkCard";
import type { PaymentDetailed } from "@/lib/api";
import type { Notifications } from "@/lib/types";

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
  "attention",
  "neutral",
  "critical",
];

const PAYMENTS: PaymentDetailed[] = [
  {
    id: "payment-collected",
    operator_id: "operator-fixture",
    client_id: "client-amelia",
    walk_id: "walk-biscuit",
    type: "overage",
    amount_pence: 4250,
    currency: "usd",
    stripe_payment_intent_id: "pi_fixture",
    stripe_invoice_id: null,
    superseded_at: null,
    status: "succeeded",
    receipt_url: "https://example.com/receipt",
    created_at: "2026-08-04T15:00:00Z",
    updated_at: "2026-08-04T15:00:00Z",
    refunded_amount_pence: 0,
    reversed_at: null,
    reversal_reason: null,
    credits_reversed: 0,
    credits_unrecovered: 0,
    reversal_needs_review: false,
    stripe_charge_id: null,
    client: { full_name: "Amelia Hart" },
    walk: {
      service: { name: "Private walk 60" },
      walk_pets: [{ pets: { name: "Biscuit" } }],
    },
  },
  {
    id: "payment-processing",
    operator_id: "operator-fixture",
    client_id: "client-jordan",
    walk_id: null,
    type: "subscription",
    amount_pence: 9600,
    currency: "usd",
    stripe_payment_intent_id: null,
    stripe_invoice_id: "in_fixture",
    superseded_at: null,
    status: "pending",
    receipt_url: null,
    created_at: "2026-08-05T14:00:00Z",
    updated_at: "2026-08-05T14:00:00Z",
    refunded_amount_pence: 0,
    reversed_at: null,
    reversal_reason: null,
    credits_reversed: 0,
    credits_unrecovered: 0,
    reversal_needs_review: false,
    stripe_charge_id: null,
    client: { full_name: "Jordan Lee" },
    walk: null,
  },
  {
    id: "payment-attention",
    operator_id: "operator-fixture",
    client_id: "client-mira",
    walk_id: "walk-mochi",
    type: "overage",
    amount_pence: 3250,
    currency: "usd",
    stripe_payment_intent_id: "pi_failed_fixture",
    stripe_invoice_id: null,
    superseded_at: null,
    status: "failed",
    receipt_url: null,
    created_at: "2026-08-03T18:00:00Z",
    updated_at: "2026-08-03T18:00:00Z",
    refunded_amount_pence: 0,
    reversed_at: null,
    reversal_reason: null,
    credits_reversed: 0,
    credits_unrecovered: 0,
    reversal_needs_review: false,
    stripe_charge_id: null,
    client: { full_name: "Mira Chen" },
    walk: {
      service: { name: "Neighborhood walk 30" },
      walk_pets: [{ pets: { name: "Mochi" } }],
    },
  },
  {
    id: "payment-refunded",
    operator_id: "operator-fixture",
    client_id: "client-sam",
    walk_id: null,
    type: "subscription",
    amount_pence: 6400,
    currency: "usd",
    stripe_payment_intent_id: null,
    stripe_invoice_id: "in_refund_fixture",
    superseded_at: null,
    status: "refunded",
    receipt_url: null,
    created_at: "2026-08-01T16:00:00Z",
    updated_at: "2026-08-01T16:00:00Z",
    refunded_amount_pence: 0,
    reversed_at: null,
    reversal_reason: null,
    credits_reversed: 0,
    credits_unrecovered: 0,
    reversal_needs_review: false,
    stripe_charge_id: null,
    client: { full_name: "Sam Rivera" },
    walk: null,
  },
];

const NOTIFICATIONS: Notifications[] = [
  {
    id: "notification-unread",
    operator_id: "operator-fixture",
    client_id: "client-amelia",
    type: "walk_scheduled",
    title: "Walk request confirmed",
    body: "Biscuit is scheduled for Thursday at 3:00 PM.",
    walk_id: "walk-biscuit",
    read_at: null,
    created_at: "2026-08-05T14:42:00Z",
    updated_at: "2026-08-05T14:42:00Z",
    email_status: "sent",
    email_attempts: 1,
    email_sent_at: "2026-08-05T14:43:00Z",
    email_last_error: null,
  push_status: "skipped",
  push_attempts: 0,
  push_sent_at: null,
  push_last_error: null,
  email_claimed_at: null,
  push_claimed_at: null,
  },
  {
    id: "notification-read",
    operator_id: "operator-fixture",
    client_id: "client-jordan",
    type: "walk_complete",
    title: "Walk report ready",
    body: "Nova's route and notes are ready to view.",
    walk_id: "walk-nova",
    read_at: "2026-08-04T20:00:00Z",
    created_at: "2026-08-04T19:50:00Z",
    updated_at: "2026-08-04T20:00:00Z",
    email_status: "sent",
    email_attempts: 1,
    email_sent_at: "2026-08-05T14:43:00Z",
    email_last_error: null,
  push_status: "skipped",
  push_attempts: 0,
  push_sent_at: null,
  push_last_error: null,
  email_claimed_at: null,
  push_claimed_at: null,
  },
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
  const [walkmode, setWalkmode] = useState(false);

  return (
    <div className={walkmode ? "walkmode" : undefined} style={{ background: "var(--bg)", minHeight: "100dvh" }}>
      <div className="page">
        <h1>Component kit</h1>
        <p style={{ color: "var(--text-2)" }}>Every component, every state, fixture data.</p>

        <Section title="Buttons">
          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            <Button>Primary</Button>
            <Button variant="accent">Primary alias</Button>
            <Button variant="ghost">Secondary</Button>
            <Button variant="danger">Destructive</Button>
            <Button disabled>Unavailable</Button>
            <button type="button" className="text-button">Text action</button>
          </div>
          <Button full>Full width</Button>
        </Section>

        <Section title="Fields">
          <Input label="Client name" placeholder="Amelia Hart" />
          <Input label="With error" defaultValue="bad@" error="That doesn't look like an email" />
          <Input label="Unavailable" defaultValue="Managed by your plan" disabled />
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
            <CreditMeter balance={1} threshold={2} cycleCredits={10} label="Low balance" />
          </Card>
        </Section>

        <Section title="Money and payment states">
          <MoneyValueRail payments={PAYMENTS} />
          <div className="payment-ledger">
            {PAYMENTS.map((payment) => (
              <PaymentRow key={payment.id} payment={payment} showClient />
            ))}
          </div>
        </Section>

        <Section title="Client relationship states">
          <header className="client-relationship-header">
            <span className="section-label">Client</span>
            <div className="client-relationship-header__title">
              <h1>Amelia Hart</h1>
              <span className="client-relationship-header__credits numeral">7 <span>credits</span></span>
            </div>
            <div className="client-relationship-header__meta">
              <span>amelia@example.com</span>
              <span>(312) 555-0147</span>
              <Badge status="completed">Active</Badge>
            </div>
          </header>
          <div className="client-list" style={{ marginTop: 0 }}>
            <button type="button" className="client-row">
              <span className="client-row__identity"><strong>Amelia Hart</strong><span>Biscuit</span></span>
              <span className="client-row__state">
                <span className="client-row__credits numeral">7 <span>credits</span></span>
                <Badge status="completed">Active</Badge>
              </span>
            </button>
            <button type="button" className="client-row">
              <span className="client-row__identity"><strong>Mira Chen</strong><span>Mochi · Pickle</span></span>
              <span className="client-row__state">
                <span className="client-row__credits numeral">2 <span>credits</span></span>
                <Badge status="scheduled">Invited</Badge>
              </span>
            </button>
          </div>
          <div className="notification-inbox">
            <NotificationList
              items={NOTIFICATIONS}
              onOpen={() => undefined}
              onMarkRead={() => undefined}
            />
          </div>
        </Section>

        <Section title="WalkCard">
          <div className="walk-list">
            <WalkCard
              walk={{
                windowStart: "15:00:00",
                windowEnd: "16:00:00",
                petNames: ["Nova"],
                propertyLabel: "Riverside route",
                status: "in_progress",
                // The exact pair review H24 measured at 3.71:1: text-secondary
                // on the Kaki tint an in-progress card paints. Without a
                // clientName the card renders no secondary text at all, so the
                // gallery showed the failing combination to nobody.
                clientName: "Priya Raman",
              }}
              onClick={() => undefined}
            />
            <WalkCard
              walk={{
                windowStart: "16:30:00",
                windowEnd: "17:00:00",
                petNames: ["Biscuit", "Pickle"],
                propertyLabel: "Home loop",
                status: "scheduled",
                clientName: "Amelia Hart",
              }}
            />
            <WalkCard
              walk={{
                windowStart: "09:00:00",
                windowEnd: "10:00:00",
                petNames: ["Mochi"],
                propertyLabel: "Park route",
                status: "completed",
              }}
            />
            <WalkCard
              walk={{
                windowStart: "11:00:00",
                windowEnd: "11:30:00",
                petNames: ["Scout"],
                propertyLabel: "Neighborhood route",
                status: "cancelled",
              }}
            />
          </div>
        </Section>

        <Section title="Calendar week">
          <div className="calendar-week">
            {[
              { day: "Mon", date: "3", state: "completed", summary: "9:00 AM Mochi", label: "Complete" },
              { day: "Tue", date: "4", state: "in_progress", summary: "11:00 AM Nova", label: "Current" },
              { day: "Wed", date: "5", state: "scheduled", summary: "1:30 PM Biscuit", label: "" },
              { day: "Thu", date: "6", state: "scheduled", summary: "3:00 PM Scout", label: "" },
              { day: "Fri", date: "7", state: "cancelled", summary: "10:00 AM Pickle", label: "Cancelled" },
              { day: "Sat", date: "8", state: "scheduled", summary: "", label: "" },
              { day: "Sun", date: "9", state: "scheduled", summary: "", label: "" },
            ].map((item) => (
              <div
                key={item.day}
                className={`calendar-week__day${item.day === "Tue" ? " calendar-week__day--today" : ""}`}
              >
                <div className="calendar-week__header">
                  <div className="section-label">{item.day}</div>
                  <div className="numeral" style={{ fontSize: "var(--fs-12)" }}>{item.date}</div>
                </div>
                {item.summary && (
                  <button type="button" className={`calendar-walk calendar-walk--${item.state}`}>
                    <span className="calendar-walk__summary">{item.summary}</span>
                    {item.label && <span className="calendar-walk__status">{item.label}</span>}
                  </button>
                )}
              </div>
            ))}
          </div>
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

        <Section title="Empty, loading, offline, and error states">
          <LoadingState label="Loading today's schedule" />
          <EmptyState
            title="No walks today"
            hint="Scheduled walks appear here in route order."
            action={<Button variant="ghost">Add a walk</Button>}
          />
          <StateField
            tone="information"
            label="Offline"
            title="Your route is still being recorded"
            detail="Route points are saved on this device and will sync when the connection returns."
          />
          <div className="walk-live-state walk-live-state--offline">
            <span className="walk-live-state__label walk-live-state__label--offline">OFFLINE</span>
            <span className="walk-live-state__pet">Biscuit</span>
            <span className="walk-live-state__detail">
              Route points are saved on this device and will sync when the connection returns.
            </span>
          </div>
          <StateField
            tone="attention"
            label="Needs attention"
            title="Couldn't load the calendar"
            detail="Check your connection and try again."
            action={<Button>Retry</Button>}
          />
          <StateField
            tone="success"
            label="Complete"
            title="Changes saved"
            detail="The updated schedule is ready."
          />
        </Section>

        <Section title="Overlays & modes">
          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            <Button variant="ghost" onClick={() => setSheetOpen(true)}>Open Sheet</Button>
            <Button variant="ghost" onClick={() => setWalkmode((w) => !w)}>Toggle .walkmode</Button>
          </div>
          <div className="numeral" style={{ fontSize: "var(--fs-32)" }}>
            12:34 · 1.3 mi
          </div>
        </Section>

        <Section title="BottomNav (operator variant below)">
          <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
            Approved Today / Calendar / Clients / Money navigation; becomes a left rail ≥1024px.
          </p>
        </Section>
      </div>

      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Confirm password">
        <Input label="Password" type="password" placeholder="••••••••" />
        <div style={{ marginTop: "var(--s-4)" }}>
          <Button full onClick={() => setSheetOpen(false)}>Confirm</Button>
        </div>
      </Sheet>
      <BottomNav persona="operator" />
    </div>
  );
}
