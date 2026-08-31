// The push opt-in decision logic (review M27).
//
// Pinned here rather than through a component because `Notification`,
// `PushManager` and `serviceWorker` exist in neither vitest project — a test
// that mocked them would be testing the mock. What matters is which of the
// five states the UI is told to show, and that is pure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  base64UrlToBytes,
  canToggle,
  disablePush,
  enablePush,
  forgetPushDeviceBeforeSignOut,
  forgetPushDeviceOnSignedOut,
  type PushEnvironment,
  pushState,
  readPushEnvironment,
  reclaimPushDevice,
  subscriptionKeys,
} from "./push";

const API = vi.hoisted(() => ({
  registerPushSubscription: vi.fn(async () => "id"),
  removePushSubscription: vi.fn(async () => true),
}));
vi.mock("./api", () => ({
  registerPushSubscription: API.registerPushSubscription,
  removePushSubscription: API.removePushSubscription,
}));
vi.mock("./env", () => ({ env: { vapidPublicKey: "BHYK" } }));

beforeEach(() => {
  API.registerPushSubscription.mockReset().mockResolvedValue("id");
  API.removePushSubscription.mockReset().mockResolvedValue(true);
});

const BASE: PushEnvironment = {
  supported: true,
  vapidKey: "BHYKBshY3BflxTbegR9xB7-iTU_uOdZK_ZFY7rqrPPJbxO3PNMLAjRaw3NuIHYRwFLhAKusNb8UweMqU884c5M4",
  permission: "default",
  subscribed: false,
  workerHandlesPush: true,
};

describe("push state", () => {
  it("reports unsupported BEFORE unconfigured", () => {
    // A browser that cannot do push at all must not be told the site is
    // misconfigured: that is a different sentence pointing at a different
    // person, and the owner would go looking for a key that is already set.
    expect(pushState({ ...BASE, supported: false, vapidKey: "" })).toBe("unsupported");
    expect(pushState({ ...BASE, supported: false })).toBe("unsupported");
  });

  it("reports unconfigured when the build carries no VAPID key", () => {
    // Minting the pair is an owner action. Offering a switch that cannot work
    // is worse than saying so.
    expect(pushState({ ...BASE, vapidKey: "" })).toBe("unconfigured");
  });

  it("distinguishes denied from off, because only one of them a switch can fix", () => {
    // Once denied, the browser will not prompt again from script. A toggle
    // that silently does nothing is the worst of the five.
    expect(pushState({ ...BASE, permission: "denied" })).toBe("denied");
    expect(pushState({ ...BASE, permission: "default" })).toBe("off");
    expect(pushState({ ...BASE, permission: "granted" })).toBe("off");
    expect(pushState({ ...BASE, permission: "granted", subscribed: true })).toBe("on");
  });

  it("a denied permission is denied even when already subscribed", () => {
    // Revoking permission in site settings leaves the subscription object in
    // place. Reporting `on` would tell somebody notifications are working
    // when the browser will never display one.
    expect(pushState({ ...BASE, permission: "denied", subscribed: true })).toBe("denied");
  });

  it("a worker that cannot handle push is reported ahead of `on`", () => {
    // On an upgrade from before M27 the ACTIVE worker has no push handler at
    // all, and getRegistration() returns it regardless. Subscribing then
    // produces deliveries nothing displays. Reporting `on` for a device
    // already subscribed under such a worker would be the worse lie: it
    // claims notifications work while none can appear.
    expect(pushState({ ...BASE, workerHandlesPush: false })).toBe("stale-worker");
    expect(pushState({ ...BASE, workerHandlesPush: false, subscribed: true })).toBe("stale-worker");
    // But a real blocker still outranks it — the person cannot act on either,
    // and `denied` names the only place that CAN be undone.
    expect(pushState({ ...BASE, workerHandlesPush: false, permission: "denied" })).toBe("denied");
    expect(pushState({ ...BASE, workerHandlesPush: false, vapidKey: "" })).toBe("unconfigured");
  });

  it("only the two actionable states offer a switch", () => {
    expect(["off", "on"].map((s) => canToggle(s as never))).toEqual([true, true]);
    expect(["unsupported", "unconfigured", "denied", "stale-worker"].map((s) => canToggle(s as never)))
      .toEqual([false, false, false, false]);
  });
});

describe("key encoding", () => {
  it("decodes base64url, including the padding the browser omits", () => {
    // `applicationServerKey` wants raw bytes and a VAPID key travels as
    // base64url with no padding and with -/_ for +//. Getting this wrong
    // yields a subscription whose keys do not match the sender, and it fails
    // at the push service rather than here.
    const bytes = base64UrlToBytes(BASE.vapidKey);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04); // uncompressed point
    expect(base64UrlToBytes("-_8").length).toBe(2);
  });

  it("refuses a subscription missing either key rather than sending it", () => {
    // A subscription without both keys cannot be encrypted to. The row would
    // be written and every push to it silently never open.
    const with_ = { getKey: (n: string) => (n === "p256dh" ? new Uint8Array([1, 2]).buffer : new Uint8Array([3]).buffer) };
    expect(subscriptionKeys(with_ as never)).toEqual({ p256dh: "AQI", auth: "Aw" });
    const missing = { getKey: (n: string) => (n === "p256dh" ? new Uint8Array([1]).buffer : null) };
    expect(subscriptionKeys(missing as never)).toBeNull();
  });
});

// ── Codex review on PR #85 ───────────────────────────────────────────────
//
// Two failure paths that both end with the browser and the server disagreeing
// about whether this device is subscribed — which on a SHARED device means
// somebody receives another account's notifications.
describe("enable/disable failure paths", () => {
  const subscribeCalls: number[] = [];
  beforeEach(() => { subscribeCalls.length = 0; });

  interface FakeSub {
    endpoint: string;
    unsubscribed: boolean;
    unsubscribe: () => Promise<boolean>;
    getKey: (n: string) => ArrayBuffer | null;
  }
  function fakeSub(endpoint = "https://push.example/a"): FakeSub {
    const s: FakeSub = {
      endpoint,
      unsubscribed: false,
      unsubscribe: () => {
        s.unsubscribed = true;
        return Promise.resolve(true);
      },
      getKey: (n) => (n === "p256dh" ? new Uint8Array(65).buffer : new Uint8Array(16).buffer),
    };
    return s;
  }

  /**
   * How the active service worker behaves.
   *
   *   push-capable  a worker running the current sw.js: answers PUSH_CAPABLE?
   *   silent        a worker from before M27: receives the message, matches
   *                 none of its own cases, returns without replying. This is
   *                 the real pre-upgrade behaviour, and silence — not a "no"
   *                 — is what the page has to read correctly.
   *   never-ready   nothing has activated, so `serviceWorker.ready` does not
   *                 settle. It never rejects either, so only a timeout ends
   *                 the wait.
   */
  type WorkerMode = "push-capable" | "silent" | "never-ready";

  function stubBrowser(
    sub: FakeSub | null,
    existing: FakeSub | null = sub,
    mode: WorkerMode = "push-capable",
  ) {
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: () => Promise.resolve("granted" as NotificationPermission),
    });
    const reg = {
      active: {
        postMessage: (msg: { type?: string }, transfer?: MessagePort[]) => {
          if (mode !== "push-capable") return;
          if (msg?.type !== "PUSH_CAPABLE?") return;
          transfer?.[0]?.postMessage({ type: "PUSH_CAPABLE", push: true });
        },
      },
      pushManager: {
        subscribe: () => {
          subscribeCalls.push(1);
          return Promise.resolve(sub);
        },
        getSubscription: () => Promise.resolve(existing),
      },
    };
    vi.stubGlobal("navigator", {
      userAgent: "test",
      serviceWorker: {
        getRegistration: () => Promise.resolve(reg),
        ready: mode === "never-ready" ? new Promise(() => {}) : Promise.resolve(reg),
      },
    });
  }

  afterEach(() => vi.unstubAllGlobals());

  it("never subscribes under a worker that does not answer PUSH_CAPABLE?", async () => {
    // The active worker on an upgrade from before M27 has no `push` handler
    // and no case for this message, so it simply does not reply. Creating a
    // subscription there produces deliveries nothing displays, and the person
    // is told notifications are on.
    //
    // The predecessor of this check asked `registration.waiting != null`,
    // which is null for the whole of that upgrade — the new worker is
    // `installing`, not `waiting` — so it passed and the subscription was
    // made. That is the finding, and this case is red against it.
    vi.useFakeTimers();
    try {
      const sub = fakeSub();
      stubBrowser(sub, sub, "silent");
      const pending = enablePush();
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toBe("stale-worker");
    } finally {
      vi.useRealTimers();
    }
    expect(subscribeCalls, "subscribed anyway").toEqual([]);
    expect(API.registerPushSubscription).not.toHaveBeenCalled();
  });

  it("never subscribes before any worker has activated", async () => {
    // A first load, or a worker whose install failed: `ready` never settles.
    // Waiting forever would leave the switch as a spinner; answering "fine"
    // would subscribe against nothing at all.
    vi.useFakeTimers();
    try {
      const sub = fakeSub();
      stubBrowser(sub, sub, "never-ready");
      const pending = enablePush();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBe("stale-worker");
    } finally {
      vi.useRealTimers();
    }
    expect(subscribeCalls, "subscribed anyway").toEqual([]);
  });

  it("readPushEnvironment asks the worker too, not just enablePush", async () => {
    // Both call sites matter and they answer different questions. `enablePush`
    // decides whether to subscribe; `readPushEnvironment` decides what the
    // screen SAYS about a device already subscribed. A guard on only one of
    // them leaves the switch reading `on` under a worker that can display
    // nothing — which is the half of the finding a person actually sees.
    const sub = fakeSub();
    stubBrowser(sub, sub);
    expect((await readPushEnvironment()).workerHandlesPush).toBe(true);
    expect(pushState(await readPushEnvironment())).toBe("on");

    vi.useFakeTimers();
    try {
      stubBrowser(sub, sub, "silent");
      const pending = readPushEnvironment();
      await vi.advanceTimersByTimeAsync(2000);
      const env = await pending;
      expect(env.workerHandlesPush).toBe(false);
      expect(env.subscribed, "the browser IS subscribed — that is the case that matters").toBe(true);
      expect(pushState(env)).toBe("stale-worker");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the reclaim stands down too, if a sign-out overtakes it", async () => {
    // Symmetric: registering a device for a session that has just ended is
    // the shared-device hazard from the other side.
    const sub = fakeSub();
    stubBrowser(null, sub);
    await reclaimPushDevice(() => true);
    expect(API.registerPushSubscription).not.toHaveBeenCalled();
    await reclaimPushDevice(() => false);
    expect(API.registerPushSubscription).toHaveBeenCalled();
  });

  it("a session that ends WITHOUT sign-out still loses the browser subscription", async () => {
    // Push delivery is independent of the page's auth state, so a surviving
    // subscription keeps displaying the PREVIOUS account's notifications on a
    // signed-out — possibly handed-over — device. `reclaimPushDevice` repairs
    // that at the next sign-in, which is too late; this is the same hazard
    // reached from the direction the reclaim cannot cover.
    const sub = fakeSub();
    stubBrowser(null, sub);
    await forgetPushDeviceOnSignedOut();
    expect(sub.unsubscribed, "left the browser subscribed with no session").toBe(true);
  });

  it("stands down before unsubscribing when a sign-in has superseded it", async () => {
    // The account-switch case (Codex review on PR #85). `applyRole` awaits a
    // database query before queueing the reclaim, so this cleanup has always
    // STARTED by then — unsubscribing here loses the subscription that
    // 0049's reassigning upsert exists to hand to the new account, and leaves
    // them with push silently off.
    const sub = fakeSub();
    stubBrowser(null, sub);
    await forgetPushDeviceOnSignedOut(() => true);
    expect(sub.unsubscribed, "unsubscribed a device the new session is about to claim").toBe(false);
  });

  it("but still unsubscribes when nothing superseded it", async () => {
    // A predicate read as "always superseded" would disable the repair
    // entirely and put back the leak it exists to close.
    const sub = fakeSub();
    stubBrowser(null, sub);
    await forgetPushDeviceOnSignedOut(() => false);
    expect(sub.unsubscribed).toBe(true);
  });

  it("and does NOT reach for the removal RPC, which has no caller to scope to", async () => {
    // `fn_remove_push_subscription` is scoped to its caller and there is none.
    // Calling it would 401; the row is left to self-heal on the 404/410 the
    // unsubscribe above guarantees.
    const sub = fakeSub();
    stubBrowser(null, sub);
    await forgetPushDeviceOnSignedOut();
    expect(API.removePushSubscription).not.toHaveBeenCalled();
  });

  it("is a silent no-op when there is nothing subscribed", async () => {
    // It runs on EVERY resolution that yields no session — including every
    // page load by a signed-out visitor — so the ordinary case must cost
    // nothing and must never throw into the auth transition.
    stubBrowser(null, null);
    await expect(forgetPushDeviceOnSignedOut()).resolves.toBeUndefined();
  });

  it("never throws into the auth transition when the unsubscribe fails", async () => {
    // A cleanup that can prevent somebody being signed out is worse than the
    // leak it closes. The failure is not permanent: the next load retries.
    const sub = fakeSub();
    sub.unsubscribe = () => Promise.reject(new Error("worker gone"));
    stubBrowser(null, sub);
    await expect(forgetPushDeviceOnSignedOut()).resolves.toBeUndefined();
  });

  it("subscribes when the active worker says it handles push", async () => {
    // The other direction: a worker running the current sw.js answers, and
    // the guard must not stand in the way of the ordinary case. A check that
    // refuses everything satisfies the case above and ships a dead switch.
    const sub = fakeSub();
    stubBrowser(sub, null);
    expect(await enablePush()).toBe("on");
    expect(subscribeCalls).toEqual([1]);
    expect(API.registerPushSubscription).toHaveBeenCalled();
  });

  it("rolls the browser subscription back when the server will not record it", async () => {
    // Otherwise readPushEnvironment reports `subscribed`, the UI says `on`,
    // and — because `on` offers only the OFF action — the device stays
    // falsely enabled until somebody toggles twice.
    const sub = fakeSub();
    stubBrowser(sub);
    API.registerPushSubscription.mockRejectedValue(new Error("network"));
    await expect(enablePush()).rejects.toThrow("network");
    expect(sub.unsubscribed, "left the browser subscribed with no server row").toBe(true);
  });

  it("an ABANDONED cleanup does not delete a row the next account reclaimed", async () => {
    // A timeout stops AWAITING; it does not cancel (Codex review on PR #85,
    // eighteenth round). A stalled `unsubscribe()` settling after somebody
    // else has signed in would otherwise fall through to the RPC under the NEW
    // session — and `fn_remove_push_subscription` is caller-scoped, so it
    // deletes the row that account has just reclaimed, leaving their UI saying
    // `on` over nothing.
    const sub = fakeSub();
    stubBrowser(null, sub);
    await forgetPushDeviceBeforeSignOut(() => true);
    expect(sub.unsubscribed, "the local half should still have happened").toBe(true);
    expect(
      API.removePushSubscription,
      "an abandoned cleanup reached the server under a later session",
    ).not.toHaveBeenCalled();
  });

  it("but a cleanup that finishes in time still removes the row", async () => {
    // Or "always abandoned" would satisfy the case above and leave every
    // signed-out device's row behind — the M27 hazard the cleanup exists for.
    const sub = fakeSub();
    stubBrowser(null, sub);
    await forgetPushDeviceBeforeSignOut(() => false);
    expect(API.removePushSubscription).toHaveBeenCalled();
  });

  it("unsubscribes locally even when the removal RPC fails", async () => {
    // The sign-out path swallows this error by design, so a failed RPC used to
    // skip the local unsubscribe entirely and leave a shared device receiving
    // the PREVIOUS account's notifications.
    const sub = fakeSub();
    stubBrowser(null, sub);
    API.removePushSubscription.mockRejectedValue(new Error("offline"));
    await expect(disablePush()).rejects.toThrow("offline");
    expect(sub.unsubscribed, "the browser kept a live subscription").toBe(true);
  });

  it("sign-out never throws, and still forgets the device locally", async () => {
    const sub = fakeSub();
    stubBrowser(null, sub);
    API.removePushSubscription.mockRejectedValue(new Error("offline"));
    await forgetPushDeviceBeforeSignOut();
    expect(sub.unsubscribed).toBe(true);
  });
});

describe("reclaiming a device the sign-out path never saw", () => {
  // A session can end without signOut — a failed refresh token, cleared auth
  // storage, a tab killed mid-session. The browser subscription survives all
  // of them, and the next account would otherwise keep receiving the previous
  // one's notifications while never receiving its own.
  interface FakeSub {
    endpoint: string;
    unsubscribe: () => Promise<boolean>;
    getKey: (n: string) => ArrayBuffer | null;
  }
  function stub(sub: FakeSub | null) {
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: () => Promise.resolve("granted") });
    vi.stubGlobal("navigator", {
      userAgent: "test",
      serviceWorker: {
        getRegistration: () => Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(sub) } }),
      },
    });
  }
  const sub: FakeSub = {
    endpoint: "https://push.example/survivor",
    unsubscribe: () => Promise.resolve(true),
    getKey: (n) => (n === "p256dh" ? new Uint8Array(65).buffer : new Uint8Array(16).buffer),
  };
  afterEach(() => vi.unstubAllGlobals());

  it("re-registers a surviving subscription for whoever is signed in now", async () => {
    stub(sub);
    await reclaimPushDevice();
    expect(API.registerPushSubscription).toHaveBeenCalledWith(
      "https://push.example/survivor",
      expect.any(String),
      expect.any(String),
      "test",
    );
  });

  it("does nothing when this browser has no subscription", async () => {
    stub(null);
    await reclaimPushDevice();
    expect(API.registerPushSubscription).not.toHaveBeenCalled();
  });

  it("never throws — it is a repair, not a precondition for signing in", async () => {
    // The RPC refuses a caller who is not yet an operator or a client, which
    // is the ordinary state mid-onboarding.
    stub(sub);
    API.registerPushSubscription.mockRejectedValue(new Error("caller is neither"));
    await reclaimPushDevice();
  });
});
