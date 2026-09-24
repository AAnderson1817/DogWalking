// Turning email back on (0054), for the client persona.
//
// Renders nothing unless email to the client's contact address is off, or was
// just turned back on here: a section announcing that email works would be one
// more thing to read on every visit, for the case where nobody needs to act.
//
// The server decides everything (`fn_email_lift_decision`). This file only
// says what each answer means for the person reading it, and whose move it is.
import { useEffect, useRef, useState } from "react";
import { FormError } from "@/components/fields";
import { loadErrorMessage } from "@/components/LoadError";
import {
  getMyEmailStatus,
  liftMyEmailSuppression,
  UnrecognisedEmailStatusError,
  type EmailLiftState,
  type MyEmailStatus,
} from "@/lib/api";

/** The states in which email to the contact address is off. */
const OFF: ReadonlySet<EmailLiftState> = new Set<EmailLiftState>([
  "ready",
  "needs_link_sign_in",
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
      return `${why} You signed in with a link sent to that address, so you can turn email back on.`;
    case "needs_link_sign_in":
      // The proof is the session (0054): it has to have begun with a link
      // sent to this address and opened after the unsubscribe. A password
      // sign-in, or a link opened before it, shows nothing about who reads
      // the inbox now.
      return (
        `${why} To turn it back on, show that the address is still yours: sign `
        + `out, choose "Use a magic link instead" on the sign-in screen, and `
        + `open the link we send to ${email}. Then come back here.`
      );
    case "not_confirmed":
      // A reset link, not a magic link. GoTrue sends an unconfirmed account's
      // magic-link request through signup, which a project with signup
      // closed refuses, while a reset link is not gated on signup and opening
      // it confirms the address (recoverVerify).
      return (
        `${why} To turn it back on here, your sign-in address has to be `
        + `confirmed first: sign out, choose "Forgot your password?" on the `
        + `sign-in screen, and open the reset link we send to ${email}. `
        + "Opening it confirms the address."
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
      // The address the server decided about, not the one read earlier: the
      // contact address can change between the offer and the press.
      const email = answer.email ?? status?.email ?? "your address";
      if (answer.result === "lifted" || answer.result === "not_suppressed") {
        // The answer IS the new state, so no second read is needed, and none
        // can fail after the lift succeeded and leave an error beside the
        // confirmation. `not_suppressed` means another tab, or a second
        // press, got there first.
        setDone(
          answer.result === "lifted"
            ? `Email is back on. Walk updates and billing notices will go to ${email}.`
            : `Email is already on for ${email}.`,
        );
        setStatus({ email: answer.email, state: "not_suppressed" });
      } else {
        // Refused: the server decided differently from the answer the button
        // was offered on, because the address, the account or the session
        // changed in between. The refusal carries its new reading, so the
        // section shows that, and never keeps offering a button the server
        // has just refused.
        setError("Email wasn't turned back on.");
        setStatus(
          answer.result === "not_client" ? null : { email: answer.email, state: answer.result },
        );
      }
      headingRef.current?.focus();
    } catch (e) {
      setError(
        e instanceof UnrecognisedEmailStatusError
          ? "This page is older than the server's answer, so we can't tell whether email is back on. Reload the page to check."
          : loadErrorMessage(e),
      );
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
