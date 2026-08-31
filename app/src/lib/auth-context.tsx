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
import { createSerialRunner, type SerialRunner } from "./serial-repair";

/** Long enough for a local unsubscribe and one RPC; short enough that a
 * stalled network cannot keep somebody signed in on a shared device. */
const SIGN_OUT_CLEANUP_MS = 3000;
import {
  forgetPushDeviceBeforeSignOut,
  forgetPushDeviceOnSignedOut,
  reclaimPushDevice,
} from "./push";
import { withTimeout } from "./with-timeout";
import { Sheet } from "@/components/Sheet";
import { FormError, Input } from "@/components/fields";
import { LoadingState } from "@/components/StateField";
import { accountHasPassword } from "./api";
import { fetchMfaGate, stepUpWithCode } from "./mfa";
import type { OperatorBillingState } from "./operator-access";
import { Button } from "@/components/Button";

export type Role = "operator" | "client" | null;

export interface AuthState {
  session: Session | null;
  role: Role;
  operatorId: string | null;
  clientId: string | null;
  /** The operator's trial/subscription state, fetched with role resolution
   * so the subscription gate (review H31) cannot need a second request that
   * fails separately. Null for clients and for a null role. */
  operatorBilling: OperatorBillingState | null;
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
    /** The operators row's billing state, or null when no row exists. */
    operatorBilling(id: string): Promise<OperatorBillingState | null>;
    clientIdFor(userId: string): Promise<string | null>;
  },
): Promise<{
  role: Role;
  operatorId: string | null;
  clientId: string | null;
  billing: OperatorBillingState | null;
}> {
  const billing = await queries.operatorBilling(userId);
  if (billing) {
    return { role: "operator", operatorId: userId, clientId: null, billing };
  }
  const clientId = await queries.clientIdFor(userId);
  if (clientId) return { role: "client", operatorId: null, clientId, billing: null };
  return { role: null, operatorId: null, clientId: null, billing: null };
}

const realQueries = {
  async operatorBilling(id: string): Promise<OperatorBillingState | null> {
    // Throw on a real query error instead of swallowing it: a transient
    // failure must NOT read as "no operators row", which would resolve an
    // existing operator to role=null and strand them on the onboarding form.
    // The same discipline covers the billing fields — fetched IN the role
    // query, so the H31 gate can never see "no data" from a failure this
    // path would have surfaced as roleError.
    const { data, error } = await supabase
      .from("operators")
      .select("id, trial_ends_at, platform_subscription_status, platform_customer_id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      trialEndsAt: data.trial_ends_at,
      platformSubscriptionStatus: data.platform_subscription_status,
      hasBilling: data.platform_customer_id !== null,
    };
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
  const [operatorBilling, setOperatorBilling] = useState<OperatorBillingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [roleError, setRoleError] = useState(false);
  const resolvedFor = useRef<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  // The two push repairs are opposites — one unsubscribes this browser, the
  // other re-registers it — and both were fire-and-forget, so a null-session
  // callback followed quickly by a signed-in one could run them CONCURRENTLY
  // (Codex review on PR #85). Both begin by reading
  // `pushManager.getSubscription()`, so either completion order is wrong.
  // See `createSerialRunner` for the three rules and why they are tested there
  // rather than through this provider.
  //
  // The version is the AUTH TRANSITION's, bumped the moment one arrives rather
  // than when a repair is scheduled (Codex review on PR #85, fifteenth round).
  // Scheduling is too late in both directions: a running cleanup only learned
  // it had been superseded once the reclaim was queued — after a database
  // round trip, long after two service-worker lookups have finished, so it
  // never learned in time — and a role lookup begun BEFORE a sign-out could
  // finish after it and queue its reclaim as the newest repair, making the
  // sign-out's cleanup stand down while the previous account's subscription
  // stayed live. That is the shared-device leak the cleanup exists to close,
  // reintroduced by the stand-down added to protect the account switch.
  const transition = useRef(0);
  // The uid the current version belongs to. `undefined` until the first
  // resolution, so an opening null session is itself a change.
  const identity = useRef<string | null | undefined>(undefined);
  const runPushRepair = useRef<SerialRunner>(
    createSerialRunner(() => transition.current),
  ).current;

  const applyRole = useCallback(async (
    uid: string,
    // Defaults to the current transition: `refreshRole` is not a transition,
    // it re-resolves the session already in hand.
    version: number = transition.current,
  ): Promise<Role> => {
    const resolved = await resolveRole(uid, realQueries);
    resolvedFor.current = uid;
    setRoleError(false);
    setRole(resolved.role);
    setOperatorId(resolved.operatorId);
    setClientId(resolved.clientId);
    setOperatorBilling(resolved.billing);
    // Claim any browser subscription that survived a session ending WITHOUT
    // the sign-out path — a failed refresh token, cleared auth storage, a tab
    // killed mid-session (Codex review on PR #85). Without this the device
    // keeps delivering the previous account's notifications and never gets
    // this one's, and the UI cannot repair it because `on` offers only OFF.
    //
    // Fire-and-forget and never throwing: it is a repair, not a precondition
    // for being signed in, and the RPC refuses a caller who is not yet an
    // operator or a client (mid-onboarding), which must not block anything.
    runPushRepair(reclaimPushDevice, version);
    return resolved.role;
  }, [runPushRepair]);

  useEffect(() => {
    let cancelled = false;

    async function apply(next: Session | null) {
      if (cancelled) return;
      setSession(next);
      sessionRef.current = next;
      const uid = next?.user?.id ?? null;
      // Bumped on arrival — see the note beside `transition` — but ONLY when
      // the IDENTITY changes (Codex review on PR #85, seventeenth round).
      //
      // supabase-js emits SIGNED_IN again for an already-signed-in user (a
      // refocused tab) and TOKEN_REFRESHED with the same session on a timer.
      // Treating those as transitions superseded a reclaim that was between
      // its service-worker lookups and its RPC, and the `resolvedFor` early
      // return below then scheduled no replacement — so on a shared device the
      // surviving subscription stayed owned by the PREVIOUS account while the
      // UI reported push as on. The version means "whose session is this",
      // and a token refresh does not change the answer.
      if (identity.current !== uid) {
        identity.current = uid;
        transition.current += 1;
      }
      const version = transition.current;
      if (!uid) {
        resolvedFor.current = null;
        setRole(null);
        setOperatorId(null);
        setClientId(null);
        setOperatorBilling(null);
        setLoading(false);
        // No session means no browser subscription (Codex review on PR #85).
        // The reclaim below repairs a surviving one at the NEXT sign-in, which
        // is too late: push delivery does not care about the page's auth
        // state, so until then the device keeps displaying the previous
        // account's notifications while signed out. Deliberate sign-out
        // already unsubscribed, so this is a no-op there; it is the ungraceful
        // ends — a failed refresh, cleared storage, a killed tab — that reach
        // here with a live subscription. Fire-and-forget for the same reason
        // the reclaim is: a repair must not stand between anyone and being
        // signed out.
        runPushRepair(forgetPushDeviceOnSignedOut, version);
        return;
      }
      if (resolvedFor.current === uid) return; // role already resolved
      try {
        if (!cancelled) await applyRole(uid, version);
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
      // Nothing this provider scheduled is current any more. A role lookup
      // already in flight still resolves and still queues its reclaim, and
      // without this the repair would run against a torn-down provider —
      // acting on a session nobody is in. Bumping the transition invalidates
      // every in-flight repair by the same rule a newer transition does.
      transition.current += 1;
      sub.subscription.unsubscribe();
    };
  }, [applyRole, runPushRepair]);

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
    // BEFORE the session goes, unlike the two cleanups below — and the
    // difference is not stylistic. Those clear local storage and need no
    // caller; `fn_remove_push_subscription` is scoped to the CALLER and cannot
    // run once there is none. Leaving the row behind means that on a shared
    // device the next person's notifications reach a browser registration the
    // previous person owns (review M27).
    // BOUNDED (Codex review on PR #85). `forgetPushDeviceBeforeSignOut`
    // catches rejections, but a promise that never SETTLES is not a rejection
    // — a stalled `unsubscribe()` or a hung RPC left this await pending
    // forever, so the button did nothing, gave no feedback, and the person
    // walked away from a shared device still signed in. That is the exact
    // hazard the cleanup exists to prevent, caused by the cleanup.
    //
    // Losing the cleanup is survivable and this is not: the SIGNED_OUT
    // transition below queues `forgetPushDeviceOnSignedOut`, which retries the
    // local half on this load and every one after it.
    await withTimeout(forgetPushDeviceBeforeSignOut(), SIGN_OUT_CLEANUP_MS);
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
    setOperatorBilling(null);
    setRoleError(false);
  }, []);

  const value = useMemo(
    () => ({
      session,
      role,
      operatorId,
      clientId,
      operatorBilling,
      loading,
      roleError,
      reauth,
      refreshRole,
      signOut,
    }),
    [session, role, operatorId, clientId, operatorBilling, loading, roleError, reauth, refreshRole, signOut],
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
 * `SignIn`'s magic link CREATED accounts until review H31 (shouldCreateUser
 * defaulted true), and no operator path forced a password — so operators
 * exist who hold a perfectly valid session and no password at all. Every
 * vault attempt answered "password verification failed", which reads as a
 * typo to somebody who has nothing to mistype, and five of them returned
 * 429. /signup collects a password now, but the accounts minted before it
 * are why this path stays.
 *
 * The check lives HERE rather than in each `reauth()` caller for two reasons.
 * There are four call sites and a fifth will exist; and this way the operator
 * never makes the doomed request at all — they are asked for the thing that
 * will actually work, once, before anything is attempted.
 *
 * The same reasoning gives the sheet its TOTP step (review H2's client
 * half). Once a verified factor exists, the vault refuses any aal1 session
 * as `second_factor_required` — AFTER the password was verified and a rate
 * slot spent. So the sheet asks for the code up front, exactly when the
 * session actually needs it (`fetchMfaGate` mirrors the server's
 * resolveAssurance, and a session already at aal2 is never asked), and
 * `challengeAndVerify` upgrades the session in place — covering magic-link
 * sessions and sessions that predate enrolment alike, with no sign-out.
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
  const [code, setCode] = useState("");
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [mfaGate, setMfaGate] = useState<{ factorId: string } | null>(null);
  const [mfaChecked, setMfaChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHasPassword(null);
    setMfaGate(null);
    setMfaChecked(false);
    setError(null);
    accountHasPassword()
      .then((has) => { if (!cancelled) setHasPassword(has); })
      // Failing OPEN to the password form is the right default: the vault
      // still refuses safely on the server, and assuming "no password" on a
      // lookup failure would push every operator through a password reset.
      .catch(() => { if (!cancelled) setHasPassword(true); });
    // fetchMfaGate fails open internally (null = password only), same rule.
    fetchMfaGate()
      .then((gate) => {
        if (cancelled) return;
        setMfaGate(gate);
        setMfaChecked(true);
      })
      .catch(() => { if (!cancelled) setMfaChecked(true); });
    return () => { cancelled = true; };
  }, [open]);

  function reset() {
    setPassword("");
    setConfirm("");
    setCode("");
    setError(null);
    setBusy(false);
  }

  /** The TOTP step, shared by both forms. True = proceed; false = refused
   * (error already shown), and nothing has been settled or changed. */
  async function passStepUp(): Promise<boolean> {
    if (!mfaGate) return true;
    const err = await stepUpWithCode(mfaGate.factorId, code.trim());
    if (err) {
      // A factor deleted since this sheet opened (dashboard recovery, or
      // another tab) makes this gate stale forever — GoTrue's raw "Factor
      // not found" names no remedy, and without clearing the gate every
      // retry re-challenges a factor that no longer exists.
      if (/factor.*not.*found/i.test(err)) {
        setMfaGate(null);
        setCode("");
        setError("Two-factor was changed on another device — press the button again to continue.");
        return false;
      }
      setError(err);
      return false;
    }
    // The session is aal2 now; a retry of THIS sheet must not demand a
    // second code for a step already passed.
    setMfaGate(null);
    return true;
  }

  async function submitExisting(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    if (!(await passStepUp())) {
      setBusy(false);
      return;
    }
    setBusy(false);
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
    // Step up BEFORE the password write: an account with a verified factor
    // gets its password changed by an aal2 session, never by the bare
    // session whose theft the factor exists to contain.
    if (!(await passStepUp())) {
      setBusy(false);
      return;
    }
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
      {hasPassword === null || !mfaChecked
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
            {mfaGate && (
              <Input
                label="Two-factor code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
            <FormError message={error} />
            <Button
              type="submit"
              full
              disabled={!password || busy || (settingUp && !confirm) ||
                (mfaGate !== null && !code.trim())}
            >
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
