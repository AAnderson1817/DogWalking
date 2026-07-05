// Typed environment access (spec 06). Required keys fail fast at first
// access with a clear message; VITE_MAPBOX_TOKEN is optional — MapView
// falls back to the SVG polyline renderer when absent.

function required(name: "VITE_SUPABASE_URL" | "VITE_SUPABASE_ANON_KEY"): string {
  const value = import.meta.env[name] as string | undefined;
  if (value) return value;
  if (import.meta.env.DEV) {
    // Local shell development without a running Supabase API: fall back to
    // the conventional local ports so the router shell stays navigable.
    console.warn(`${name} is not set; using local-stack default (app/.env.local)`);
    return name === "VITE_SUPABASE_URL"
      ? "http://127.0.0.1:54321"
      : "anon-key-not-configured";
  }
  throw new Error(`${name} is required — set it in app/.env.local (see .env.example)`);
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
