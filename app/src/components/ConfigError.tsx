/**
 * The screen a misconfigured deployment shows instead of nothing.
 *
 * Review H22: a build with a missing or mistyped `VITE_*` variable served a
 * blank page — `#root` empty, one uncaught error in the console, no error
 * surface anywhere. This is what replaces that.
 *
 * Deliberately plain: no design tokens, no imports beyond React, no
 * `components.css`. It has to render when the app's own module graph may be
 * the thing that is broken, so it carries its own styles inline and depends on
 * nothing that could be missing for the same reason it is being shown.
 *
 * It names the variables. They are `VITE_*`, which means they are compiled
 * into the client bundle and public by construction — there is nothing to leak,
 * and the name is the entire actionable content for whoever has to fix it.
 */
export function ConfigError({ missing }: { missing: readonly string[] }) {
  return (
    <main
      style={{
        maxWidth: "34rem",
        margin: "0 auto",
        padding: "3rem 1.5rem",
        fontFamily: "system-ui, sans-serif",
        color: "#0C4774",
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: "1.5rem", fontWeight: 800, margin: "0 0 0.75rem" }}>
        Sanpo is not configured
      </h1>
      <p style={{ margin: "0 0 1rem" }}>
        This deployment is missing the settings it needs to reach its database,
        so nothing can load. Nobody's data is affected — the app has not
        started.
      </p>
      <p style={{ margin: "0 0 0.5rem", fontWeight: 700 }}>
        {missing.length === 1 ? "Missing variable:" : "Missing variables:"}
      </p>
      <ul style={{ margin: "0 0 1.5rem", paddingLeft: "1.25rem" }}>
        {missing.map((name) => (
          <li key={name}>
            <code style={{ fontFamily: "ui-monospace, monospace" }}>{name}</code>
          </li>
        ))}
      </ul>
      <p style={{ margin: 0, fontSize: "0.9rem" }}>
        Set these in the hosting provider's environment settings and redeploy.
        See <code style={{ fontFamily: "ui-monospace, monospace" }}>app/.env.example</code>.
      </p>
    </main>
  );
}
