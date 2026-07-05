// Session + resolved persona (spec 06). Role resolution on session:
// operators row by uid ⇒ operator, else clients row by auth_user_id ⇒
// client, else null (fresh signup → Onboard). reauth() opens a
// password-confirm sheet and resolves to the entered password (or null on
// cancel) — the string is handed straight to vault calls, never stored.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { Sheet } from "@/components/Sheet";
import { Input } from "@/components/fields";
import { Button } from "@/components/Button";

export type Role = "operator" | "client" | null;

export interface AuthState {
  session: Session | null;
  role: Role;
  operatorId: string | null;
  clientId: string | null;
  loading: boolean;
  /** Password-confirm for vault calls; resolves to the password or null. */
  reauth: () => Promise<string | null>;
  /** Re-run role resolution (after Onboard creates the operators row, or a claim links a client). */
  refreshRole: () => Promise<void>;
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
  const sessionRef = useRef<Session | null>(null);

  const applyRole = useCallback(async (uid: string) => {
    const resolved = await resolveRole(uid, realQueries);
    resolvedFor.current = uid;
    setRole(resolved.role);
    setOperatorId(resolved.operatorId);
    setClientId(resolved.clientId);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function apply(next: Session | null) {
      if (cancelled) return;
      setSession(next);
      sessionRef.current = next;
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
        if (!cancelled) await applyRole(uid);
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
  }, [applyRole]);

  const refreshRole = useCallback(async () => {
    const uid = sessionRef.current?.user?.id;
    if (uid) await applyRole(uid);
  }, [applyRole]);

  // ── reauth sheet ─────────────────────────────────────────────────────────
  const [reauthOpen, setReauthOpen] = useState(false);
  const reauthResolver = useRef<((password: string | null) => void) | null>(null);

  const reauth = useCallback((): Promise<string | null> => {
    setReauthOpen(true);
    return new Promise<string | null>((resolve) => {
      reauthResolver.current = resolve;
    });
  }, []);

  const settleReauth = useCallback((password: string | null) => {
    setReauthOpen(false);
    reauthResolver.current?.(password);
    reauthResolver.current = null;
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    resolvedFor.current = null;
    setRole(null);
    setOperatorId(null);
    setClientId(null);
  }, []);

  const value = useMemo(
    () => ({ session, role, operatorId, clientId, loading, reauth, refreshRole, signOut }),
    [session, role, operatorId, clientId, loading, reauth, refreshRole, signOut],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <ReauthSheet open={reauthOpen} onSettle={settleReauth} />
    </AuthContext.Provider>
  );
}

function ReauthSheet({
  open,
  onSettle,
}: {
  open: boolean;
  onSettle: (password: string | null) => void;
}) {
  const [password, setPassword] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    onSettle(password);
    setPassword("");
  }

  function cancel() {
    onSettle(null);
    setPassword("");
  }

  return (
    <Sheet open={open} onClose={cancel} title="Confirm it's you">
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
          Access credentials are protected. Re-enter your password to continue;
          every reveal is recorded in the audit trail.
        </p>
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <Button type="submit" full disabled={!password}>
          Confirm
        </Button>
        <Button type="button" variant="ghost" full onClick={cancel}>
          Cancel
        </Button>
      </form>
    </Sheet>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
