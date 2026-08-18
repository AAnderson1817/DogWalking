// Label and tone for a credential audit row (review H3).
//
// Separate from the component for the same reason status-treatment.ts is:
// oxlint runs with --deny-warnings and a component file exporting plain
// functions breaks fast refresh. It also means these can be unit-tested
// without rendering anything.
import type { CredentialLogRow } from "@/lib/api";

/** Past-tense, client-facing wording. The enum is written for the database. */
export function accessActionLabel(action: CredentialLogRow["action"]): string {
  switch (action) {
    case "read":
      return "Entry code viewed";
    case "create":
      return "Entry code added";
    case "rotate":
      return "Entry code changed";
    case "revoke":
      return "Access removed";
    case "reauth_failed":
      return "Failed sign-in check";
  }
}

/**
 * Which rows deserve visual attention.
 *
 * Only the failed check. A reveal is the walker doing their job — the whole
 * point of the vault — and colouring every entry as an alert would train the
 * client to ignore the one row that is genuinely worth reading.
 */
export function accessActionTone(action: CredentialLogRow["action"]): "attention" | "neutral" {
  return action === "reauth_failed" ? "attention" : "neutral";
}
