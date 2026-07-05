// Session + resolved persona (spec 06). Role resolution on session:
// operators row by uid ⇒ operator, else clients row by auth_user_id ⇒
// client, else null (fresh signup → Onboard). reauth() opens the
// password-confirm sheet (wired in phase 04).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type Role = "operator" | "client" | null;

export interface AuthState {
  session: Session | null;
  role: Role;
  operatorId: string | null;
  clientId: string | null;
  loading: boolean;
  /** Password-confirm for vault calls; resolves to the password or null. */
  reauth: () => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Pure role resolution — unit-tested with mocked queries (phase 04). */
export async function resolveRole(
  userId: string,
  queries: {
    operatorExists(id: string): Promise<boolean>;
    clientIdFor(userId: string): Promise<string | null>;
  },
): Promise<{ role: Role; operatorId: string | null; clientId: string | null }> {
  if (await queries.operatorExists(userId)) {
    return { role: "operator", operatorId: userId, clientId: null };
  }
  const clientId = await queries.clientIdFor(userId);
  if (clientId) return { role: "client", operatorId: null, clientId };
  return { role: null, operatorId: null, clientId: null };
}

const realQueries = {
  async operatorExists(id: string): Promise<boolean> {
    const { data } = await supabase.from("operators").select("id").eq("id", id).maybeSingle();
    return Boolean(data);
  },
  async clientIdFor(userId: string): Promise<string | null> {
    const { data } = await supabase
      .from("clients").select("id").eq("auth_user_id", userId).maybeSingle();
    return data?.id ?? null;
  },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role>(null);
  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const resolvedFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function apply(next: Session | null) {
      if (cancelled) return;
      setSession(next);
      const uid = next?.user?.id ?? null;
      if (!uid) {
        resolvedFor.current = null;
        setRole(null);
        setOperatorId(null);
        setClientId(null);
        setLoading(false);
        return;
      }
      if (resolvedFor.current === uid) return; // role already resolved
      try {
        const resolved = await resolveRole(uid, realQueries);
        if (cancelled) return;
        resolvedFor.current = uid;
        setRole(resolved.role);
        setOperatorId(resolved.operatorId);
        setClientId(resolved.clientId);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    supabase.auth.getSession().then(({ data }) => void apply(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      void apply(next);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const reauth = useCallback(async (): Promise<string | null> => {
    // Replaced by the password-confirm Sheet in phase 04.
    throw new Error("reauth() is wired in phase 04");
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    resolvedFor.current = null;
    setRole(null);
    setOperatorId(null);
    setClientId(null);
  }, []);

  const value = useMemo(
    () => ({ session, role, operatorId, clientId, loading, reauth, signOut }),
    [session, role, operatorId, clientId, loading, reauth, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
