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
import { deleteOutboxDatabase } from "./gps-outbox";
import { clearAllWalkSnapshots } from "./walk-snapshot";
import { Sheet } from "@/components/Sheet";
import { FormError, Input } from "@/components/fields";
import { LoadingState } from "@/components/StateField";
import { accountHasPassword } from "./api";
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
    // Review M8. Sign-out used to clear the session and three pieces of React
    // state and nothing else, so this device kept raw GPS coordinates for
    // another person's client — plus that walk's notes, care toggles and photo
    // paths — indefinitely. Worse than it looks: the outbox is constructed
    // only inside Walk Mode, so after sign-out no drain loop existed to clear
    // them, and they sat there until the NEXT operator opened Walk Mode, at
    // which point the batches were POSTed under the new session.
    //
    // Same shape as the service-worker cache leak already fixed in qc(1-4),
    // in the two persistence layers that never got the same treatment.
    //
    // Deliberately AFTER the session is gone and deliberately non-throwing:
    // sign-out must complete even if storage is unavailable. Leaving someone
    // signed in because a cleanup failed is strictly worse than the leak.
    await deleteOutboxDatabase();
    clearAllWalkSnapshots();
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

/**
 * Confirm-it's-you, and — since review M2 — set-a-password-first when there is
 * no password to confirm with.
 *
 * `SignIn` offers a magic link, `signInWithOtp` creates the account, and no
 * operator path anywhere sets a password. So an operator could hold a
 * perfectly valid session and be unable to open the vault at all: every
 * attempt answered "password verification failed", which reads as a typo to
 * somebody who has nothing to mistype, and five of them returned 429.
 *
 * The check lives HERE rather than in each `reauth()` caller for two reasons.
 * There are four call sites and a fifth will exist; and this way the operator
 * never makes the doomed request at all — they are asked for the thing that
 * will actually work, once, before anything is attempted.
 */
function ReauthSheet({
  open,
  onSettle,
}: {
  open: boolean;
  onSettle: (password: string | null) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHasPassword(null);
    setError(null);
    accountHasPassword()
      .then((has) => { if (!cancelled) setHasPassword(has); })
      // Failing OPEN to the password form is the right default: the vault
      // still refuses safely on the server, and assuming "no password" on a
      // lookup failure would push every operator through a password reset.
      .catch(() => { if (!cancelled) setHasPassword(true); });
    return () => { cancelled = true; };
  }, [open]);

  function reset() {
    setPassword("");
    setConfirm("");
    setError(null);
    setBusy(false);
  }

  function submitExisting(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    onSettle(password);
    reset();
  }

  async function submitNew(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Those don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) {
      // Surfaced, not swallowed. `secure_password_change` can require a recent
      // sign-in, and an operator who has been idle needs to be told that
      // rather than left staring at a form that does nothing.
      setError(err.message);
      return;
    }
    // Straight through to the action they were trying to take — setting the
    // password IS the re-auth, and making them type it again would be ceremony.
    onSettle(password);
    reset();
  }

  function cancel() {
    onSettle(null);
    reset();
  }

  const settingUp = hasPassword === false;

  return (
    <Sheet open={open} onClose={cancel} title={settingUp ? "Set a password" : "Confirm it's you"}>
      {hasPassword === null
        ? <LoadingState label="Checking your account" />
        : (
          <form
            onSubmit={settingUp ? submitNew : submitExisting}
            style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}
          >
            <p style={{ color: "var(--text-2)", fontSize: "var(--fs-14)" }}>
              {settingUp
                ? "You sign in with a magic link, so there's no password on this account yet. Set one now — it's what protects your clients' entry codes, and every reveal is recorded against it."
                : "Access credentials are protected. Re-enter your password to continue; every reveal is recorded in the audit trail."}
            </p>
            <Input
              label={settingUp ? "New password" : "Password"}
              type="password"
              autoComplete={settingUp ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            {settingUp && (
              <Input
                label="Confirm password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            )}
            <FormError message={error} />
            <Button type="submit" full disabled={!password || busy || (settingUp && !confirm)}>
              {busy ? "Saving…" : settingUp ? "Set password and continue" : "Confirm"}
            </Button>
            <Button type="button" variant="ghost" full onClick={cancel}>
              Cancel
            </Button>
          </form>
        )}
    </Sheet>
  );
}

// oxlint-disable-next-line react/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
