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
  /** True when role resolution FAILED (query error) rather than resolving to
   * a genuine null persona. Guards keep a signed-in user off the onboarding
   * form on a transient failure. */
  roleError: boolean;
  /** Password-confirm for vault calls; resolves to the password or null. */
  reauth: () => Promise<string | null>;
  /** Re-run role resolution (after Onboard creates the operators row, or a
   * claim links a client). Resolves to the freshly resolved role so callers
   * can branch without waiting for the context re-render. */
  refreshRole: () => Promise<Role>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Pure role resolution — unit-tested with mocked queries (phase 04). */
// oxlint-disable-next-line react/only-export-components
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
    // Throw on a real query error instead of swallowing it: a transient
    // failure must NOT read as "no operators row", which would resolve an
    // existing operator to role=null and strand them on the onboarding form.
    const { data, error } = await supabase.from("operators").select("id").eq("id", id).maybeSingle();
    if (error) throw error;
    return Boolean(data);
  },
  async clientIdFor(userId: string): Promise<string | null> {
    const { data, error } = await supabase
      .from("clients").select("id").eq("auth_user_id", userId).maybeSingle();
    if (error) throw error;
    return data?.id ?? null;
  },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role>(null);
  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [roleError, setRoleError] = useState(false);
  const resolvedFor = useRef<string | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const applyRole = useCallback(async (uid: string): Promise<Role> => {
    const resolved = await resolveRole(uid, realQueries);
    resolvedFor.current = uid;
    setRoleError(false);
    setRole(resolved.role);
    setOperatorId(resolved.operatorId);
    setClientId(resolved.clientId);
    return resolved.role;
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
      } catch {
        // Resolution failed (network/5xx/token race). Do NOT leave role=null
        // masquerading as "no persona"; flag the error so guards can offer a
        // retry instead of dumping the user on the onboarding form. But if a
        // concurrent apply() already resolved this same user (getSession +
        // onAuthStateChange both fire on load), don't clobber that success
        // with a stale rejection.
        if (!cancelled && resolvedFor.current !== uid) setRoleError(true);
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

  const refreshRole = useCallback(async (): Promise<Role> => {
    const uid = sessionRef.current?.user?.id;
    if (!uid) return null;
    try {
      return await applyRole(uid);
    } catch {
      setRoleError(true);
      return null;
    }
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
    setRoleError(false);
  }, []);

  const value = useMemo(
    () => ({ session, role, operatorId, clientId, loading, roleError, reauth, refreshRole, signOut }),
    [session, role, operatorId, clientId, loading, roleError, reauth, refreshRole, signOut],
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

// oxlint-disable-next-line react/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
