// Service-role Supabase client (spec 04 shared _lib).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

let cached: SupabaseClient | null = null;

export function adminClient(): SupabaseClient {
  if (!cached) {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) {
      throw new Error("supabase url / service credentials are not configured");
    }
    cached = createClient(url, key, {
      // No `auth.throwOnError` here, deliberately: it would make every
      // `.auth.*` call REJECT instead of resolving `{ data, error }`, and
      // `app/scripts/discarded-errors.test.ts` classifies `.auth` chains on
      // the resolved envelope. A call site cannot tell the option is set, so
      // the gate would go wrong silently; if it is ever wanted, that gate
      // moves first.
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
