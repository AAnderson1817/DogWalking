import { Link } from "react-router-dom";
import { StateField } from "@/components/StateField";

export default function NotFound() {
  return (
    <div className="page">
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
