// Typed environment access (spec 06). VITE_MAPBOX_TOKEN is optional — MapView
// falls back to the SVG polyline renderer when absent.
//
// Review H22: this file used to THROW from a getter when a required key was
// missing, and `supabase.ts` reads those getters at module-evaluation time. So
// the throw happened inside the import graph, before `main.tsx` ever ran and
// therefore before the `ErrorBoundary` existed to catch it. The result was a
// blank `#root` and one uncaught page error — reproduced end to end: build with
// no env vars, serve `dist/`, `#root.innerHTML.length === 0`.
//
// A deploy with a mistyped variable passed typecheck, lint, tests, build and
// brand verification, then served a blank page to every user. With no
// monitoring (H14), nobody finds out until a customer calls.
//
// So nothing here throws any more. Missing configuration is DATA now —
// `missingEnvKeys()` — and `main.tsx` renders a panel that says so. The build
// itself is gated separately by `scripts/verify-env.mjs`, which is what makes
// spec 06's "build fails on missing required keys" true rather than aspirational.

export const REQUIRED_ENV_KEYS = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"] as const;
type RequiredKey = (typeof REQUIRED_ENV_KEYS)[number];

/**
 * Syntactically valid and permanently unroutable. `createClient` rejects an
 * empty string, so the client still has to be constructible with something —
 * and `.invalid` is reserved by RFC 2606, so this can never accidentally
 * resolve to a real host if the panel is ever bypassed.
 */
const UNCONFIGURED_URL = "https://unconfigured.invalid";
const UNCONFIGURED_KEY = "unconfigured";

function read(name: RequiredKey): string | undefined {
  return import.meta.env[name] as string | undefined;
}

/** Required keys with no value, in declaration order. Empty when configured. */
export function missingEnvKeys(): RequiredKey[] {
  // DEV has a deliberate local-stack fallback below, so it is never "missing".
  if (import.meta.env.DEV) return [];
  return REQUIRED_ENV_KEYS.filter((name) => !read(name));
}

function required(name: RequiredKey): string {
  const value = read(name);
  if (value) return value;
  if (import.meta.env.DEV) {
    // Local shell development without a running Supabase API: fall back to
    // the conventional local ports so the router shell stays navigable.
    console.warn(`${name} is not set; using local-stack default (app/.env.local)`);
    return name === "VITE_SUPABASE_URL"
      ? "http://127.0.0.1:54321"
      : "anon-key-not-configured";
  }
  return name === "VITE_SUPABASE_URL" ? UNCONFIGURED_URL : UNCONFIGURED_KEY;
}

export const env = {
  get supabaseUrl(): string {
    return required("VITE_SUPABASE_URL");
  },
  get supabaseAnonKey(): string {
    return required("VITE_SUPABASE_ANON_KEY");
  },
  get mapboxToken(): string | null {
    return (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) ?? null;
  },
};
