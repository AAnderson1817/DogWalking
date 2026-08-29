// Review H6: the one place the notice is linked from, so the four entry points
// cannot drift apart.
//
// There was previously nowhere in the information architecture a notice could
// even be linked from — the finding's phrase, and it was literally true: the
// route table had no /legal, /privacy or /settings, and a grep for
// `privacy|terms of|consent|by continuing` across app/src returned
// `rollover_policy` and one code comment.
import { Link } from "react-router-dom";

/**
 * `variant="accept"` is the wording used where continuing IS the acceptance —
 * signup and invite claim. It is deliberately a statement of what the button
 * does rather than a checkbox: a checkbox that everyone ticks records consent
 * to having ticked a checkbox, and this product's honest claim is narrower —
 * that the notice was shown, at this version, at this moment, and the person
 * proceeded.
 */
export function LegalLinks({ variant = "footer" }: { variant?: "footer" | "accept" }) {
  const links = (
    <>
      <Link to="/legal/privacy">Privacy notice</Link>
      {" · "}
      <Link to="/legal/terms">Terms of service</Link>
    </>
  );

  if (variant === "accept") {
    return (
      <p className="legal-links legal-links--accept">
        By continuing you accept the {links}.
      </p>
    );
  }
  return <p className="legal-links">{links}</p>;
}
