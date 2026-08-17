import { Link } from "react-router-dom";
import { StateField } from "@/components/StateField";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function NotFound() {
  useDocumentTitle("Page not found");
  return (
    <div className="page">
      {/* The StateField title is a <p>; a route with no h1 is invisible to
          heading navigation. Hidden rather than shown because the field
          already says this on screen. */}
      <h1 className="sr-only">Page not found</h1>
      <StateField
        tone="information"
        label="404"
        title="This page doesn't exist"
        detail="The link may be old or incomplete."
        action={<Link className="secondary-link" to="/">Back to Today</Link>}
      />
    </div>
  );
}
