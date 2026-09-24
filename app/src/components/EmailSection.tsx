// Turning email back on (0054), for the client persona.
//
// Renders nothing unless email to the client's contact address is off, or was
// just turned back on here: a section announcing that email works would be one
// more thing to read on every visit, for the case where nobody needs to act.
//
// The server decides everything (`fn_email_lift_decision`). This file only
// says what each answer means for the person reading it, and whose move it is.
import { useCallback, useEffect, useRef, useState } from "react";
import { FormError } from "@/components/fields";
import {
  getMyEmailStatus,
  liftMyEmailSuppression,
  type EmailLiftState,
  type MyEmailStatus,
} from "@/lib/api";

/** The states in which email to the contact address is off. */
const OFF: ReadonlySet<EmailLiftState> = new Set<EmailLiftState>([
  "ready",
  "not_confirmed",
  "not_login_address",
  "not_liftable",
]);

function emailOffExplanation(
  state: EmailLiftState,
  email: string,
  walkerName: string | null,
): string | null {
  const why =
    `Email to ${email} is turned off, because someone using that address `
    + "unsubscribed from Sanpo email. You won't get walk updates or billing "
    + "notices by email; they still appear here.";
  switch (state) {
    case "ready":
      return `${why} It's the address you sign in with, so you can turn email back on.`;
    case "not_confirmed":
      // GoTrue sets `email_confirmed_at` when a link it sent is opened; a
      // sign-in link does it as well as a confirmation link does.
      return (
        `${why} To turn it back on here, your sign-in address has to be `
        + `confirmed first: sign out, then sign in with a link sent to ${email}. `
        + "Opening that link confirms it."
      );
    case "not_login_address":
      return (
        `${why} Only the address you sign in with can be turned back on here, `
        + `and you sign in with a different one. To get email at your sign-in `
        + `address instead, ask ${walkerName ?? "your walker"} to change it.`
      );
    case "not_liftable":
      return `Email to ${email} is turned off by a preference that can't be changed here.`;
    default:
      return null;
  }
}

export function EmailSection({ walkerName }: { walkerName: string | null }) {
  const [status, setStatus] = useState<MyEmailStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const refresh = useCallback(async (): Promise<MyEmailStatus | null> => {
    const next = await getMyEmailStatus();
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    let live = true;
    getMyEmailStatus().then(
      (s) => {
        if (live) setStatus(s);
      },
      // Advisory. A failed read must not replace a working portal with an
      // error (the M39 rule the operator's notice follows too); without an
      // answer this section has nothing true to say, so it says nothing.
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  async function lift() {
    setBusy(true);
    setError(null);
    try {
      const answer = await liftMyEmailSuppression();
      const email = status?.email ?? "your address";
      if (answer === "lifted" || answer === "not_suppressed") {
        // The answer IS the new state, so no second read is needed, and none
        // can fail after the lift succeeded and leave an error beside the
        // confirmation. `not_suppressed` means another tab, or a second
        // press, got there first.
        setDone(
          answer === "lifted"
            ? `Email is back on. Walk updates and billing notices will go to ${email}.`
            : `Email is already on for ${email}.`,
        );
        setStatus((s) => (s ? { ...s, state: "not_suppressed" } : s));
      } else {
        // The server decided differently from the answer the button was
        // offered on: the address or the account changed in between. Its
        // new reading is what the section should now say.
        setError("Email wasn't turned back on.");
        try {
          await refresh();
        } catch {
          // The error above already says the lift did not happen.
        }
      }
      headingRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not turn email back on.");
    } finally {
      setBusy(false);
    }
  }

  const off = status !== null && status.email !== null && OFF.has(status.state);
  if (!off && done === null && error === null) return null;

  const explanation = off && status?.email
    ? emailOffExplanation(status.state, status.email, walkerName)
    : null;

  return (
    <section className="settings-section" aria-labelledby="portal-email">
      <h2 id="portal-email" tabIndex={-1} ref={headingRef}>Email</h2>
      <FormError message={error} />
      {/* Polite, and mounted before its text arrives: the confirmation lands
          just after the press, and a region that appears with its text is
          announced far less reliably (the FormError rule). */}
      <p className="form-note" role="status">{done}</p>
      {explanation && <p className="text-secondary">{explanation}</p>}
      {off && status?.state === "ready" && (
        <button type="button" className="btn" onClick={() => void lift()} disabled={busy}>
          {busy ? "Working…" : "Turn email back on"}
        </button>
      )}
    </section>
  );
}
