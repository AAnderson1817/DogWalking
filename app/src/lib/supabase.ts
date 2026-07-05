// Browser Supabase client (spec 06): anon key, persisted session.
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { env } from "./env";

export const supabase = createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
