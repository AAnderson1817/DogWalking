// Review H6: /legal/privacy and /legal/terms.
//
// Public routes. The people who most need the privacy notice are the ones who
// have not signed in — somebody who received an email they did not expect, or
// who is deciding whether to claim an invite at all — so putting it behind auth
// would hide it from its own audience.
import { Link, useParams } from "react-router-dom";
import { LEGAL_DOCUMENTS, type LegalSlug } from "@/lib/legal";
import { useDocumentTitle } from "@/lib/use-document-title";

function isSlug(v: string | undefined): v is LegalSlug {
  return v === "privacy" || v === "terms";
}

export default function Legal() {
  const { slug } = useParams<{ slug: string }>();
  const doc = isSlug(slug) ? LEGAL_DOCUMENTS[slug] : null;
  useDocumentTitle(doc?.title ?? "Not found");

  if (!doc) {
    return (
      <div className="page legal-page">
        <h1>Not found</h1>
        <p className="legal-page__meta">
          <Link to="/legal/privacy">Privacy notice</Link> ·{" "}
          <Link to="/legal/terms">Terms of service</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="page legal-page">
      <h1>{doc.title}</h1>
      <p className="legal-page__meta">
        Version {doc.version} · Updated {doc.updated}
      </p>
      <p className="legal-page__intro">{doc.intro}</p>

      {doc.sections.map((section) => (
        <section key={section.heading} className="legal-page__section">
          <h2>{section.heading}</h2>
          {section.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
          {section.bullets && (
            <ul>
              {section.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <p className="legal-page__meta">
        {slug === "privacy"
          ? <Link to="/legal/terms">Terms of service</Link>
          : <Link to="/legal/privacy">Privacy notice</Link>}
      </p>
    </div>
  );
}
