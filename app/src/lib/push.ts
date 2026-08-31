/**
 * Web Push opt-in for both personas (review M27).
 *
 * The decision logic is separated from the browser calls so it can be tested
 * at all: `Notification`, `PushManager` and `serviceWorker` are not present in
 * either vitest project, and a hook that reached for them directly would be
 * testable only by mocking the platform — which tests the mock.
 */
import { env } from "./env";
import { withTimeout } from "./with-timeout";
import { registerPushSubscription, removePushSubscription } from "./api";

/**
 * What the UI should show. Five states, not a boolean, because "off" has four
 * different causes and three of them are not something a switch can fix:
 *
 *   unsupported   this browser has no Push API (iOS Safari outside an
 *                 installed PWA, most notably) — offering a switch is a lie.
 *   unconfigured  no VAPID key in this build. An owner action, not a user's.
 *   denied        the person refused, and the browser will not ask again from
 *                 script. Only site settings can undo it, so say so.
 *   off           available, permitted or not yet asked, not subscribed.
 *   on            subscribed on this device.
 */
export type PushState =
  | "unsupported"
  | "unconfigured"
  | "denied"
  | "stale-worker"
  | "off"
  | "on";

export interface PushEnvironment {
  supported: boolean;
  vapidKey: string;
  permission: NotificationPermission | null;
  subscribed: boolean;
  /**
   * The ACTIVE service worker answered "yes, I handle push".
   *
   * Asked rather than inferred (Codex review on PR #85). This was
   * `registration.waiting != null`, which is neither necessary nor
   * sufficient: an upgrade from the pre-M27 worker spends its whole install
   * in `installing`, where `waiting` is still null and the active worker has
   * no `push` handler; and a deploy that changes nothing about push leaves a
   * worker WAITING while the active one handles push perfectly well, which
   * that check reported as broken.
   */
  workerHandlesPush: boolean;
}

export function pushState(e: PushEnvironment): PushState {
  // Support is checked BEFORE configuration: a browser that cannot do push at
  // all should not be told the site is misconfigured, which is a different
  // sentence pointing at a different person.
  if (!e.supported) return "unsupported";
  if (!e.vapidKey) return "unconfigured";
  if (e.permission === "denied") return "denied";
  // The active worker could not confirm it handles push, so a subscription
  // made here would deliver to something that ignores it: every push silent
  // until the person happens to reload (Codex review on PR #85).
  //
  // Reported ahead of `on` deliberately. A device that IS subscribed under a
  // worker that cannot display anything is the case that matters — saying
  // `on` there would claim notifications work while none can be shown.
  if (!e.workerHandlesPush) return "stale-worker";
  return e.subscribed ? "on" : "off";
}

/** Whether the toggle can do anything, so the UI never renders a dead switch. */
export function canToggle(state: PushState): boolean {
  return state === "off" || state === "on";
}

/**
 * `applicationServerKey` wants raw bytes; VAPID keys travel as base64url.
 *
 * Hand-rolled rather than reaching for a helper: this is the one conversion in
 * the browser half, and getting it wrong yields a subscription whose keys do
 * not match the sender — which fails at the push service, not here.
 */
export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The `p256dh` / `auth` pair, base64url, as the RPC wants them. */
export function subscriptionKeys(
  sub: Pick<PushSubscription, "getKey">,
): { p256dh: string; auth: string } | null {
  const p256dh = sub.getKey("p256dh");
  const auth = sub.getKey("auth");
  if (!p256dh || !auth) return null;
  return { p256dh: bytesToB64Url(p256dh), auth: bytesToB64Url(auth) };
}

function bytesToB64Url(buf: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined" &&
    typeof Notification !== "undefined"
  );
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/**
 * How long to wait for a worker to activate, and then to answer.
 *
 * Both are bounded because both can hang forever rather than fail.
 * `serviceWorker.ready` never rejects — if nothing ever activates it simply
 * does not settle — and a worker with no matching message handler never
 * replies. An unbounded await here would leave the Settings screen showing a
 * spinner where a switch belongs, with nothing on screen saying why.
 */
const WORKER_READY_MS = 3000;
const WORKER_REPLY_MS = 1000;


/**
 * Ask the ACTIVE worker whether it handles push, over a MessagePort.
 *
 * Silence is a NO, and that is the load-bearing half. A worker from before
 * M27 receives this message, matches none of its own cases and returns
 * without replying — so the timeout is how the page learns the worker
 * predates push. The only way to get `true` is for a worker running the
 * current `sw.js` to say so.
 */
function askWorker(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    let channel: MessageChannel;
    try {
      channel = new MessageChannel();
    } catch {
      return resolve(false);
    }
    const settle = (answer: boolean) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(answer);
    };
    const timer = setTimeout(() => settle(false), WORKER_REPLY_MS);
    channel.port1.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; push?: unknown } | null;
      settle(data?.type === "PUSH_CAPABLE" && data.push === true);
    };
    try {
      worker.postMessage({ type: "PUSH_CAPABLE?" }, [channel.port2]);
    } catch {
      settle(false);
    }
  });
}

/**
 * Whether a push delivered right now would be displayed.
 *
 * `serviceWorker.ready` rather than `getRegistration()`: it settles only once
 * there IS an active worker, which is the one this question is about, and it
 * covers the first-load case where a registration exists but nothing has
 * activated yet by waiting instead of answering wrongly.
 */
export async function activeWorkerHandlesPush(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await withTimeout(navigator.serviceWorker.ready, WORKER_READY_MS);
  const active = reg?.active ?? null;
  if (!active) return false;
  return await askWorker(active);
}

export async function readPushEnvironment(): Promise<PushEnvironment> {
  const supported = pushSupported();
  const reg = supported ? await registration() : null;
  const existing = reg ? await reg.pushManager.getSubscription() : null;
  return {
    supported,
    vapidKey: env.vapidPublicKey,
    permission: supported ? Notification.permission : null,
    subscribed: existing !== null,
    workerHandlesPush: supported ? await activeWorkerHandlesPush() : false,
  };
}

/** Subscribe this device and record it. Returns the resulting state. */
export async function enablePush(): Promise<PushState> {
  const reg = await registration();
  if (!reg || !env.vapidPublicKey) return "unconfigured";
  // Refuse rather than create a subscription the active worker cannot serve.
  // Re-asked here rather than trusted from the last render: the worker can
  // change under a screen that has been open for a while, and this is the
  // moment the permission prompt and the subscription are about to happen.
  if (!(await activeWorkerHandlesPush())) return "stale-worker";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(env.vapidPublicKey) as BufferSource,
  });
  const keys = subscriptionKeys(sub);
  if (!keys) {
    // A subscription without keys cannot be encrypted to. Undo it rather than
    // leave the browser holding one the server can never use.
    await sub.unsubscribe();
    return "off";
  }
  try {
    await registerPushSubscription(sub.endpoint, keys.p256dh, keys.auth, navigator.userAgent);
  } catch (e) {
    // Roll the browser subscription back (Codex review on PR #85). Leaving it
    // makes `readPushEnvironment` report `subscribed`, so the UI says `on`
    // while the server holds no row — and because `on` offers only the OFF
    // action, the device stays falsely enabled until somebody toggles twice.
    // The missing-keys branch above already did this; the failure path did
    // not, which is the inconsistency that made it wrong.
    await sub.unsubscribe().catch(() => {});
    throw e;
  }
  return "on";
}

/**
 * Forget this device, in the browser AND on the server.
 *
 * The browser half goes FIRST and is never skipped, which reverses the order
 * this shipped with (Codex review on PR #85). The original reasoning — that a
 * server row pointing at a dead endpoint is the worse leftover — had it
 * backwards on both counts:
 *
 *   - A stale server row SELF-HEALS. The push service answers 410 and the
 *     send path deletes the registration; that path exists and is tested.
 *   - A browser left subscribed does not. On the sign-out path the error is
 *     swallowed by design, so a failed RPC used to skip the local unsubscribe
 *     entirely and leave the device receiving the PREVIOUS account's
 *     notifications — the exact shared-device hazard 0049's reassigning
 *     upsert exists to prevent, arrived at from the other side.
 *
 * The server call still runs, and still throws, so the UI can say the row may
 * not have been removed. It just no longer decides whether the local half
 * happens.
 */
export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    const { endpoint } = sub;
    try {
      await sub.unsubscribe();
    } finally {
      await removePushSubscription(endpoint);
    }
  }
  return pushSupported() ? (env.vapidPublicKey ? "off" : "unconfigured") : "unsupported";
}

/**
 * Drop this browser's subscription the moment there is NO session.
 *
 * `reclaimPushDevice` below repairs a surviving subscription at the next
 * sign-in, and that is too late (Codex review on PR #85). Push delivery is
 * entirely independent of the page's auth state: between an ungraceful
 * session end — a failed refresh token, cleared auth storage, a tab killed
 * mid-session — and whenever somebody next signs in, the push service keeps
 * delivering and the service worker keeps DISPLAYING the previous account's
 * notifications, on a device that is signed out or already in somebody else's
 * hands. Client names on a stranger's lock screen is the hazard the whole of
 * 0049's shared-device design exists for, reached from the one direction the
 * reclaim could not cover.
 *
 * Local only, and that is not a compromise: `fn_remove_push_subscription` is
 * scoped to the caller, and there is no caller. Unsubscribing invalidates the
 * endpoint at the push service, so the next delivery attempt gets 404/410 and
 * `deliverPush` drops the row — the self-heal that path already implements.
 *
 * The cost is honest and stated rather than hidden: a session that ends for
 * any reason now costs this device its push registration, so the person turns
 * notifications back on. That is already true of every deliberate sign-out
 * (which unsubscribes locally first), it is the safe direction, and the
 * alternative is a live subscription owned by an account with no session.
 *
 * Best-effort, because it runs inside the auth transition and must never
 * prevent anyone from being signed out. A failure is not permanent: this runs
 * on EVERY resolution that yields no session, so the next page load retries.
 */
export async function forgetPushDeviceOnSignedOut(
  superseded: () => boolean = () => false,
): Promise<void> {
  try {
    const reg = await registration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    // Immediately before the irreversible step, not at the top (Codex review
    // on PR #85). A sign-in arriving while this was reading the registration
    // means the device now belongs to somebody who is signed IN, and
    // `reclaimPushDevice` is about to reassign it to them — unsubscribing
    // first would leave them with push silently off.
    if (sub && !superseded()) await sub.unsubscribe();
  } catch {
    /* see above — retried on the next resolution that yields no session */
  }
}

/**
 * Claim any existing browser subscription for whoever is signed in NOW.
 *
 * The sign-out cleanup below only covers the graceful path. A session can end
 * without it — a refresh token that fails, cleared auth storage, a tab killed
 * mid-session — and the browser's subscription survives all of them (Codex
 * review on PR #85). The next person to sign in then finds
 * `readPushEnvironment` reporting `subscribed: true`, so the UI says `on` and
 * offers only the OFF action, and nothing ever re-registers it: the device
 * keeps receiving the PREVIOUS account's notifications and never receives the
 * current one's.
 *
 * Re-registering is the whole fix, and it needs no new machinery because
 * `fn_register_push_subscription` already upserts and reassigns — the
 * primitive the shared-device case required is exactly the one that repairs
 * this. It is idempotent, so running it on every resolved session is a no-op
 * once the row already belongs to the caller.
 *
 * Best effort by design: a caller who is neither an operator nor a client
 * (mid-onboarding, before the row exists) is refused by the function, and
 * that must not break signing in.
 */
export async function reclaimPushDevice(
  superseded: () => boolean = () => false,
): Promise<void> {
  try {
    const reg = await registration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return;
    const keys = subscriptionKeys(sub);
    if (!keys) return;
    // Symmetric with the cleanup above: a sign-OUT arriving while this was
    // reading the subscription means claiming it for that session is wrong.
    if (superseded()) return;
    await registerPushSubscription(sub.endpoint, keys.p256dh, keys.auth, navigator.userAgent);
  } catch {
    /* see above */
  }
}

/**
 * Sign-out cleanup (the M8 rule, one layer out).
 *
 * MUST run BEFORE `supabase.auth.signOut()`, which is the opposite of the
 * outbox and snapshot cleanups beside it: those are local storage and need no
 * session, while `fn_remove_push_subscription` is scoped to the CALLER and
 * simply cannot run once there is no caller. Getting the order wrong leaves
 * the row behind, and on a shared device the next person's notifications are
 * then delivered to a browser registration the previous person owns.
 *
 * Never throws, for the same reason the others do not: leaving somebody signed
 * in because a cleanup failed is strictly worse than the leak.
 */
export async function forgetPushDeviceBeforeSignOut(): Promise<void> {
  try {
    await disablePush();
  } catch {
    /* best effort — see above */
  }
}
