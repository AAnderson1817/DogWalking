import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="page" style={{ display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center" }}>
        <h1 className="display" style={{ fontSize: "var(--fs-44)" }}>404</h1>
        <p style={{ color: "var(--text-2)", marginTop: "var(--s-2)" }}>
          This trail doesn't exist.
        </p>
        <p style={{ marginTop: "var(--s-4)" }}>
          <Link to="/" style={{ color: "var(--pine-600)" }}>Head home</Link>
        </p>
      </div>
    </div>
  );
}
