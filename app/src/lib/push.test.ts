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
  type PushEnvironment,
  pushState,
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

  it("only the two actionable states offer a switch", () => {
    expect(["off", "on"].map((s) => canToggle(s as never))).toEqual([true, true]);
    expect(["unsupported", "unconfigured", "denied"].map((s) => canToggle(s as never)))
      .toEqual([false, false, false]);
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

  function stubBrowser(sub: FakeSub | null, existing: FakeSub | null = sub) {
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: () => Promise.resolve("granted" as NotificationPermission),
    });
    vi.stubGlobal("navigator", {
      userAgent: "test",
      serviceWorker: {
        getRegistration: () =>
          Promise.resolve({
            pushManager: {
              subscribe: () => Promise.resolve(sub),
              getSubscription: () => Promise.resolve(existing),
            },
          }),
      },
    });
  }

  afterEach(() => vi.unstubAllGlobals());

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
