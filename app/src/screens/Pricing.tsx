// /pricing — the public page that states the price (review H31: "a public
// page that states the price"). One plan, no tiers, no table: the figure,
// the trial, and what the money buys.
import { Link } from "react-router-dom";
import { BrandLogo } from "@/components/BrandLogo";
import { Card } from "@/components/Card";
import { LegalLinks } from "@/components/LegalLinks";
import { money } from "@/lib/format";
import { PLATFORM_PRICE_PENCE, TRIAL_DAYS } from "@/lib/operator-access";
import { useDocumentTitle } from "@/lib/use-document-title";

const INCLUDED = [
  "Client roster with invites, pet profiles and secure entry-code storage",
  "Recurring schedules, a drag-and-drop calendar, and nightly walk generation",
  "Live GPS walk tracking with photo report cards sent to every client",
  "Credits, plans and pay-per-visit billing — your clients pay you directly through Stripe",
  "A client portal for booking, cancelling and payment",
];

export default function Pricing() {
  useDocumentTitle("Pricing");
  return (
    <div className="page" style={{ display: "grid", placeItems: "center" }}>
      <div style={{ width: "100%", maxWidth: 480 }}>
        <div style={{ textAlign: "center", marginBottom: "var(--s-6)" }}>
          <h1 className="sr-only">Sanpo pricing</h1>
          <BrandLogo />
          <p style={{ color: "var(--text-2)" }}>
            Solo-first software for independent pet-care professionals.
          </p>
        </div>
        <Card>
          <p style={{ fontSize: "var(--fs-32)", fontWeight: 800, margin: 0, textAlign: "center" }}>
            {money(PLATFORM_PRICE_PENCE)}
            <span style={{ fontSize: "var(--fs-16)", fontWeight: 600, color: "var(--text-2)" }}>
              /month
            </span>
          </p>
          <p style={{ textAlign: "center", color: "var(--text-2)", marginTop: "var(--s-1)" }}>
            After a {TRIAL_DAYS}-day free trial. No card needed to start; cancel any time.
          </p>
          <ul style={{ paddingLeft: "var(--s-5)", margin: "var(--s-4) 0" }}>
            {INCLUDED.map((line) => (
              <li key={line} style={{ marginBottom: "var(--s-2)" }}>
                {line}
              </li>
            ))}
          </ul>
          <p style={{ fontSize: "var(--fs-14)", color: "var(--text-2)" }}>
            Card processing for your clients' payments is billed by Stripe at their
            standard rates, on your own Stripe account.
          </p>
          {/* A real link styled as the primary action — a <button> nested in
              an <a> is invalid HTML (interactive inside interactive). */}
          <Link to="/signup" className="btn btn--primary btn--full">
            Start your free trial
          </Link>
          <p style={{ textAlign: "center", fontSize: "var(--fs-14)", marginTop: "var(--s-3)" }}>
            Already have an account? <Link to="/signin">Sign in</Link>
          </p>
        </Card>
        <LegalLinks />
      </div>
    </div>
  );
}
