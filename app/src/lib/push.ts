/**
 * Web Push opt-in for both personas (review M27).
 *
 * The decision logic is separated from the browser calls so it can be tested
 * at all: `Notification`, `PushManager` and `serviceWorker` are not present in
 * either vitest project, and a hook that reached for them directly would be
 * testable only by mocking the platform — which tests the mock.
 */
import { env } from "./env";
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
export type PushState = "unsupported" | "unconfigured" | "denied" | "off" | "on";

export interface PushEnvironment {
  supported: boolean;
  vapidKey: string;
  permission: NotificationPermission | null;
  subscribed: boolean;
}

export function pushState(e: PushEnvironment): PushState {
  // Support is checked BEFORE configuration: a browser that cannot do push at
  // all should not be told the site is misconfigured, which is a different
  // sentence pointing at a different person.
  if (!e.supported) return "unsupported";
  if (!e.vapidKey) return "unconfigured";
  if (e.permission === "denied") return "denied";
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

export async function readPushEnvironment(): Promise<PushEnvironment> {
  const supported = pushSupported();
  const reg = supported ? await registration() : null;
  const existing = reg ? await reg.pushManager.getSubscription() : null;
  return {
    supported,
    vapidKey: env.vapidPublicKey,
    permission: supported ? Notification.permission : null,
    subscribed: existing !== null,
  };
}

/** Subscribe this device and record it. Returns the resulting state. */
export async function enablePush(): Promise<PushState> {
  const reg = await registration();
  if (!reg || !env.vapidPublicKey) return "unconfigured";

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
  await registerPushSubscription(sub.endpoint, keys.p256dh, keys.auth, navigator.userAgent);
  return "on";
}

/**
 * Forget this device, on the server AND in the browser.
 *
 * Both halves, in that order. Dropping only the server row leaves the browser
 * holding a subscription it will hand back unchanged on the next `subscribe()`
 * — which is fine — but dropping only the browser's leaves a row pointing at
 * an endpoint nothing will ever accept, and the send path only learns that by
 * being told 410 by the push service.
 */
export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await removePushSubscription(sub.endpoint);
    await sub.unsubscribe();
  }
  return pushSupported() ? (env.vapidPublicKey ? "off" : "unconfigured") : "unsupported";
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
