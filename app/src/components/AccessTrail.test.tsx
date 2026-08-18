// The client's read-only view of who touched their door (review H3).
//
// The audit trail was operator-only, which is what made it unable to answer the
// question it exists for: in the scenario the product implicitly promises to
// handle — a client is burgled and the walker is a suspect — a log only the
// suspect can read exonerates nobody.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessTrail } from "./AccessTrail";
import { accessActionLabel, accessActionTone } from "./access-trail-treatment";
import type { CredentialLogRow } from "@/lib/api";

const row = (over: Partial<CredentialLogRow> = {}): CredentialLogRow => ({
  id: "log-1",
  credential_id: "cred-1",
  accessed_by: "op-1",
  action: "read",
  purpose: "Pre-walk entry",
  accessed_at: "2026-08-14T19:02:00Z",
  walk_id: null,
  ...over,
});

describe("accessActionLabel", () => {
  it("gives every action client-facing words", () => {
    // The enum is written for the database; a homeowner reading "rotate"
    // learns nothing about their own door.
    expect(accessActionLabel("read")).toBe("Entry code viewed");
    expect(accessActionLabel("create")).toBe("Entry code added");
    expect(accessActionLabel("rotate")).toBe("Entry code changed");
    expect(accessActionLabel("revoke")).toBe("Access removed");
    expect(accessActionLabel("reauth_failed")).toBe("Failed sign-in check");
  });

  it("names no action with the raw enum value", () => {
    const actions: CredentialLogRow["action"][] = [
      "read",
      "create",
      "rotate",
      "revoke",
      "reauth_failed",
    ];
    for (const a of actions) expect(accessActionLabel(a)).not.toContain("_");
  });
});

describe("accessActionTone", () => {
  it("marks ONLY the failed check", () => {
    // A reveal is the walker doing the job the vault exists for. Colouring
    // every row as an alert would train the client to skim past the one row
    // that is genuinely worth reading.
    expect(accessActionTone("reauth_failed")).toBe("attention");
    expect(accessActionTone("read")).toBe("neutral");
    expect(accessActionTone("create")).toBe("neutral");
    expect(accessActionTone("rotate")).toBe("neutral");
    expect(accessActionTone("revoke")).toBe("neutral");
  });
});

describe("AccessTrail", () => {
  it("shows the date AND the time", () => {
    // "Who opened my door at 2pm" is unanswerable from a date alone.
    const html = renderToStaticMarkup(<AccessTrail rows={[row()]} />);
    expect(html).toContain("Aug 14, 2026");
    expect(html).toMatch(/2:02\s?PM/);
  });

  it("carries a machine-readable timestamp", () => {
    // renderToStaticMarkup emits the JSX prop name verbatim — `dateTime`, not
    // the lowercase `datetime` a browser DOM reports. HTML attribute names are
    // case-insensitive so both parse identically; the assertion just has to
    // match what React actually writes.
    const html = renderToStaticMarkup(<AccessTrail rows={[row()]} />);
    expect(html).toContain('dateTime="2026-08-14T19:02:00Z"');
  });

  it("shows a rotation, which used to leave no trace at all", () => {
    // Before 0030 a rotation wrote only `rotated_at`, which the NEXT rotation
    // overwrote — so the history of a door's codes was one entry long.
    const html = renderToStaticMarkup(
      <AccessTrail rows={[row({ id: "r", action: "rotate", purpose: null })]} />,
    );
    expect(html).toContain("Entry code changed");
  });

  it("marks a failed sign-in check and nothing else", () => {
    const html = renderToStaticMarkup(
      <AccessTrail
        rows={[
          row({ id: "a", action: "reauth_failed", purpose: null }),
          row({ id: "b", action: "read" }),
        ]}
      />,
    );
    expect(html.match(/access-trail__row--attention/g)?.length).toBe(1);
    expect(html.match(/access-trail__row--neutral/g)?.length).toBe(1);
  });

  it("never renders an IP or user agent", () => {
    // Those describe the operator's DEVICE. A client does not need their
    // walker's IP to know their door was opened, and showing it would make the
    // trail read as surveillance of the walker.
    const html = renderToStaticMarkup(<AccessTrail rows={[row()]} />);
    expect(html).not.toContain("ip");
    expect(html.toLowerCase()).not.toContain("user agent");
    expect(html.toLowerCase()).not.toContain("user_agent");
  });

  it("omits the purpose row when there is none", () => {
    const html = renderToStaticMarkup(<AccessTrail rows={[row({ purpose: null })]} />);
    expect(html).not.toContain("access-trail__purpose");
  });

  it("says so when nothing has happened yet", () => {
    const html = renderToStaticMarkup(<AccessTrail rows={[]} />);
    expect(html).toContain("No access yet");
  });

  it("labels the list for a screen reader", () => {
    const html = renderToStaticMarkup(<AccessTrail rows={[row()]} />);
    expect(html).toContain('aria-label="Entry code activity"');
  });
});
