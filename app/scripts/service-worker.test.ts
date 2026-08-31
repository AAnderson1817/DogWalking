import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The service worker's network-only rule for Supabase traffic is a SECURITY
 * BOUNDARY, and until this file nothing enforced it.
 *
 * The Cache API is keyed by URL and knows nothing about the `Authorization`
 * header. A PostgREST response cached for account A is therefore served to
 * account B on the same device — a household tablet, a phone handed to a
 * colleague. That shipped once (qc(1–4)) and was fixed in `sw.js`; spec 06
 * went on prescribing `stale-while-revalidate for GET API/Storage` for four
 * more hardening waves, so the authoritative document still described the bug
 * (review H21).
 *
 * This drives the real `fetch` handler rather than grepping for a prefix list.
 * A grep passes against a handler that computes `isNeverCache` correctly and
 * then ignores it — and this repository has already shipped one check that a
 * COMMENT could satisfy (see the realtime `private: true` grep in ci.yml,
 * whose first version passed against the deleted option). What matters is not
 * that the paths are named; it is that `respondWith` is never called for them.
 */

const SW_SOURCE = readFileSync(
  fileURLToPath(new URL("../public/sw.js", import.meta.url)),
  "utf8",
);

interface Handlers {
  fetch?: (event: FetchEventStub) => void;
  install?: (event: { waitUntil: (p: Promise<unknown>) => void }) => void;
  message?: (event: { data: unknown }) => void;
  push?: (event: PushEventStub) => void;
  notificationclick?: (event: NotificationClickStub) => void;
}

interface PushEventStub {
  data: { json: () => unknown } | null;
  waitUntil: (p: Promise<unknown>) => void;
}

interface NotificationClickStub {
  notification: { close: () => void; data?: { url?: string } };
  waitUntil: (p: Promise<unknown>) => void;
}

interface FetchEventStub {
  request: { url: string; method: string; mode: string };
  respondWith: (r: unknown) => void;
}

/**
 * Evaluate `sw.js` with a stubbed worker global and hand back the listeners it
 * registered. The build-time placeholders are filled the way `vite.config.ts`
 * fills them, so what runs here is what ships.
 */
interface SwHarness extends Handlers {
  /** URLs `cache.add` was called with during install. */
  added: string[];
  /** URLs the fake cache refuses, to model a CDN hiccup or a 404. */
  reject: Set<string>;
  /** Whether the worker asked to take over immediately. */
  skipWaitingCalls: number;
  /** What the fake cache already holds, keyed by URL. */
  cache: Map<string, { body: string }>;
  /** URLs the fake network answers, and how. */
  network: Map<string, { ok: boolean; status: number; body: string }>;
  /** Whether the network is reachable at all. */
  offline: boolean;
  /** Notifications the worker displayed. */
  shown: Array<{ title: string; opts: Record<string, unknown> }>;
  /** URLs handed to `clients.openWindow`. */
  opened: string[];
  /** URLs of window clients that were focused. */
  focused: string[];
  /** Targets passed to `client.navigate`. */
  navigated: string[];
}

interface SwOptions {
  buildAssets?: string[];
  /** Window clients already open, by URL. */
  openWindows?: string[];
  /** What `vite.config.ts` stamps for the Today plate; null on a public-only build. */
  plateFamily?: { stem: string; fallback: string } | null;
  cache?: Map<string, { body: string }>;
  network?: Map<string, { ok: boolean; status: number; body: string }>;
  offline?: boolean;
}

function loadServiceWorker(options: SwOptions = {}): SwHarness {
  const handlers: Handlers = {};
  const added: string[] = [];
  const reject = new Set<string>();
  let skipWaitingCalls = 0;
  const cache = options.cache ?? new Map<string, { body: string }>();
  const network = options.network ?? new Map<string, { ok: boolean; status: number; body: string }>();
  const state = { offline: options.offline ?? false };
  const shown: Array<{ title: string; opts: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const focused: string[] = [];
  const navigated: string[] = [];
  const openWindows = (options.openWindows ?? []).map((url) => ({
    url,
    focus: () => {
      focused.push(url);
      return Promise.resolve();
    },
    navigate: (to: string) => {
      navigated.push(to);
      return Promise.resolve();
    },
  }));
  const source = SW_SOURCE
    .replace('"__BUILD_VERSION__"', JSON.stringify("test"))
    .replace('"__BUILD_ASSETS__"', JSON.stringify(options.buildAssets ?? ["/assets/index-abc123.js"]))
    // Filled the way the build fills it, so what runs here is what ships.
    // Defaulting to null rather than leaving the literal is deliberate: the
    // placeholder string is truthy, so an unfilled worker would take the
    // "no plate" path for the wrong reason and the tests below would pass
    // without ever exercising the rule.
    .replace('"__PLATE_FAMILY__"', JSON.stringify(options.plateFamily ?? null));

  const context: Record<string, unknown> = {
    self: {
      addEventListener: (name: string, fn: (e: never) => void) => {
        if (name === "fetch") handlers.fetch = fn as Handlers["fetch"];
        if (name === "install") handlers.install = fn as Handlers["install"];
        if (name === "message") handlers.message = fn as Handlers["message"];
        if (name === "push") handlers.push = fn as Handlers["push"];
        if (name === "notificationclick") {
          handlers.notificationclick = fn as Handlers["notificationclick"];
        }
      },
      location: { origin: "https://app.sanpo.test" },
      skipWaiting: () => {
        skipWaitingCalls += 1;
      },
      clients: {
        claim: () => Promise.resolve(),
        matchAll: () => Promise.resolve(openWindows),
        openWindow: (url: string) => {
          opened.push(url);
          return Promise.resolve();
        },
      },
      registration: {
        showNotification: (title: string, opts: Record<string, unknown>) => {
          shown.push({ title, opts });
          return Promise.resolve();
        },
      },
    },
    caches: {
      open: () =>
        Promise.resolve({
          // `cache.match` takes a Request in the worker and a URL string for
          // the fallback lookup, so the stub accepts both.
          match: (key: string | { url: string }) =>
            Promise.resolve(cache.get(typeof key === "string" ? key : new URL(key.url).pathname)),
          put: (key: string | { url: string }, value: { body: string }) => {
            cache.set(typeof key === "string" ? key : new URL(key.url).pathname, value);
            return undefined;
          },
          add: (url: string) => {
            added.push(url);
            return reject.has(url)
              ? Promise.reject(new Error(`404 ${url}`))
              : Promise.resolve();
          },
          addAll: () => Promise.resolve(),
        }),
      keys: () => Promise.resolve([]),
      match: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(true),
    },
    fetch: (request: string | { url: string }) => {
      if (state.offline) return Promise.reject(new Error("offline"));
      const path = new URL(typeof request === "string" ? request : request.url).pathname;
      const answer = network.get(path) ?? { ok: true, status: 200, body: `network:${path}` };
      return Promise.resolve({ ...answer, clone: () => ({ body: answer.body }) });
    },
    URL,
    Response: { error: () => ({ type: "error" }) },
    Promise,
    Array,
    Error,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    ...handlers,
    added,
    reject,
    cache,
    network,
    get offline() {
      return state.offline;
    },
    set offline(value: boolean) {
      state.offline = value;
    },
    get skipWaitingCalls() {
      return skipWaitingCalls;
    },
    shown,
    opened,
    focused,
    navigated,
  } as SwHarness;
}

/** Drives the push handler and awaits the notification it displayed. */
async function push(h: SwHarness, payload: unknown | "malformed"): Promise<void> {
  const waits: Array<Promise<unknown>> = [];
  h.push?.({
    data: payload === null
      ? null
      : {
        json: () => {
          if (payload === "malformed") throw new SyntaxError("not json");
          return payload;
        },
      },
    waitUntil: (pr) => void waits.push(pr),
  });
  await Promise.all(waits);
}

/** Drives a tap on a displayed notification. */
async function click(h: SwHarness, url?: string): Promise<{ closed: number }> {
  const waits: Array<Promise<unknown>> = [];
  let closed = 0;
  h.notificationclick?.({
    notification: { close: () => void (closed += 1), data: url === undefined ? undefined : { url } },
    waitUntil: (pr) => void waits.push(pr),
  });
  await Promise.all(waits);
  return { closed };
}

/** Drives the fetch handler and awaits whatever it responded with. */
async function respond(
  handlers: Handlers,
  url: string,
): Promise<{ body?: string; type?: string } | undefined> {
  let answered: unknown;
  handlers.fetch?.({
    request: { url, method: "GET", mode: "cors" },
    respondWith: (r) => {
      answered = r;
    },
  });
  return (await answered) as { body?: string; type?: string } | undefined;
}

/** Runs the install handler and reports whether it resolved or rejected. */
async function install(sw: SwHarness): Promise<"ok" | "failed"> {
  let promise: Promise<unknown> = Promise.resolve();
  sw.install?.({ waitUntil: (p) => (promise = p) });
  try {
    await promise;
    return "ok";
  } catch {
    return "failed";
  }
}

/** Returns true when the worker intercepted the request. */
function intercepts(
  handlers: Handlers,
  url: string,
  { method = "GET", mode = "cors" }: { method?: string; mode?: string } = {},
): boolean {
  let handled = false;
  handlers.fetch?.({
    request: { url, method, mode },
    respondWith: () => {
      handled = true;
    },
  });
  return handled;
}

const SUPABASE = "https://abcdefgh.supabase.co";

describe("the service worker never caches Supabase traffic", () => {
  let handlers: Handlers;
  beforeEach(() => {
    handlers = loadServiceWorker();
  });

  it("registers a fetch handler at all", () => {
    // Without this the suite below passes vacuously: an unregistered handler
    // intercepts nothing, which looks exactly like correct behaviour.
    expect(handlers.fetch).toBeTypeOf("function");
  });

  // One case per path family the boundary covers. A response cached under any
  // of these is a response served to the wrong person.
  const neverCached: [string, string][] = [
    ["REST rows", `${SUPABASE}/rest/v1/clients?select=*`],
    ["Storage objects", `${SUPABASE}/storage/v1/object/sign/walk-photos/x.jpg`],
    ["auth session", `${SUPABASE}/auth/v1/user`],
    ["realtime", `${SUPABASE}/realtime/v1/websocket`],
    ["edge functions", `${SUPABASE}/functions/v1/complete-walk`],
  ];

  for (const [what, url] of neverCached) {
    it(`goes straight to the network for ${what}`, () => {
      expect(intercepts(handlers, url), `${url} was intercepted by the worker`).toBe(false);
    });
  }

  it("goes straight to the network for every mutation, whatever the path", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        intercepts(handlers, "https://app.sanpo.test/assets/index-abc123.js", { method }),
        `${method} was intercepted`,
      ).toBe(false);
    }
  });

  it("does not intercept cross-origin requests it knows nothing about", () => {
    expect(intercepts(handlers, "https://api.mapbox.com/styles/v1/x")).toBe(false);
  });

  /**
   * The other direction. Without this, deleting the whole fetch handler would
   * make every assertion above pass — the offline shell is the thing the
   * worker exists for, and a test suite that only forbids is satisfied by
   * doing nothing at all.
   */
  it("still serves the app shell, or it is not a service worker", () => {
    expect(intercepts(handlers, "https://app.sanpo.test/assets/index-abc123.js")).toBe(true);
    expect(intercepts(handlers, "https://app.sanpo.test/roster", { mode: "navigate" })).toBe(true);
  });
});

/**
 * Review M6. Two install-time defects, both silent.
 *
 * `cache.addAll` is atomic, so ONE failing asset — a CDN hiccup, a font 404, a
 * chunk that rolled off after a fast redeploy — voided the entire install and
 * left the user on whatever worker they had, or none. And install called
 * `skipWaiting()` unconditionally, so a deploy replaced the controller under a
 * running session; `activate` then deleted the cache holding that session's
 * chunks, and the next lazy import fetched a hashed file the new deploy no
 * longer serves — a 404 mid-walk.
 */
describe("the service worker's install", () => {
  it("caches each URL separately, so one bad asset costs one asset", async () => {
    const sw = loadServiceWorker();
    sw.reject.add("/fonts/baloo-2-var.woff2");
    expect(await install(sw)).toBe("ok");
    // Everything else was still attempted — `addAll` would have abandoned the
    // whole list at the first rejection.
    expect(sw.added).toContain("/index.html");
    expect(sw.added).toContain("/manifest.webmanifest");
    expect(sw.added.length).toBeGreaterThan(3);
  });

  it("still fails when the offline document itself cannot be cached", async () => {
    // Best-effort must not mean "install a shell that cannot start". Without
    // the document there is nothing to serve a navigation, so a worker that
    // reported success would be worse than no worker at all.
    const sw = loadServiceWorker();
    sw.reject.add("/index.html");
    expect(await install(sw)).toBe("failed");
  });

  it("precaches the build's hashed assets, not just the static shell", async () => {
    const sw = loadServiceWorker();
    expect(await install(sw)).toBe("ok");
    expect(sw.added).toContain("/assets/index-abc123.js");
  });

  it("does NOT take over on its own", async () => {
    const sw = loadServiceWorker();
    await install(sw);
    expect(sw.skipWaitingCalls).toBe(0);
  });

  it("takes over only when the page asks it to", async () => {
    const sw = loadServiceWorker();
    await install(sw);
    sw.message?.({ data: { type: "SKIP_WAITING" } });
    expect(sw.skipWaitingCalls).toBe(1);
  });

  it("ignores messages it does not recognise", async () => {
    const sw = loadServiceWorker();
    await install(sw);
    sw.message?.({ data: { type: "something-else" } });
    sw.message?.({ data: null });
    sw.message?.({ data: "SKIP_WAITING" });
    expect(sw.skipWaitingCalls).toBe(0);
  });
});

/**
 * Review M17. The Today plate ships as four responsive candidates and only the
 * master is precached, so the worker has to be able to answer for the other
 * three — otherwise the change trades a byte saving for a blank primary screen
 * offline.
 *
 * That trade is not hypothetical. Measured in Chromium: when the candidate an
 * `<img srcset>` picks fails to load, the browser does NOT try another one.
 * `naturalWidth` stays 0 and nothing is painted. So "the picked variant is not
 * in the cache and the network is gone" is exactly the cold offline start the
 * `perf(today-field)` work existed to protect.
 *
 * The substitution is sound because every candidate is the same composition at
 * the same ratio and the layout is CSS-driven — measured, serving the 875x1798
 * master for a 438w URL renders at ratio 2.0548 against the plate's 2.0549.
 */
describe("the service worker substitutes the precached Today plate", () => {
  const STEM = "sanpo-today-indigo-emaki-background-approved-v1";
  const MASTER = `/assets/${STEM}-B7ae2uy3.webp`;
  const VARIANT = `/assets/${STEM}-438w-Le3xnTjr.webp`;
  const ORIGIN = "https://app.sanpo.test";
  const PLATE = { stem: STEM, fallback: MASTER };

  /** A worker whose cache already holds the precached master, as after install. */
  function installed(extra: Partial<SwOptions> = {}) {
    const cache = new Map([[MASTER, { body: "the-master-plate" }]]);
    return loadServiceWorker({ plateFamily: PLATE, buildAssets: [MASTER], cache, ...extra });
  }

  it("serves the master when the picked variant is uncached and the network is gone", async () => {
    const sw = installed({ offline: true });
    // The exact cold-offline-start case: installed on a visit that never
    // rendered Today, so the variant this device picks was never fetched.
    expect(await respond(sw, ORIGIN + VARIANT)).toEqual({ body: "the-master-plate" });
  });

  it("serves the master when the variant 404s after a redeploy", async () => {
    // A page still running the previous build asks for the PREVIOUS hashed
    // variant. That file is gone, and a 404 paints nothing just as an offline
    // failure does — so it falls back too, not only the throw.
    const sw = installed({
      network: new Map([[VARIANT, { ok: false, status: 404, body: "gone" }]]),
    });
    expect(await respond(sw, ORIGIN + VARIANT)).toEqual({ body: "the-master-plate" });
  });

  it("still prefers the real variant when it is cached", async () => {
    // Cache-first is not bypassed: a device that HAS its own candidate must
    // keep getting it, or the fallback quietly becomes the only plate anyone
    // ever sees and the whole change is inert.
    const cache = new Map([
      [MASTER, { body: "the-master-plate" }],
      [VARIANT, { body: "the-438w-variant" }],
    ]);
    const sw = loadServiceWorker({ plateFamily: PLATE, cache, offline: true });
    expect(await respond(sw, ORIGIN + VARIANT)).toEqual({ body: "the-438w-variant" });
  });

  it("prefers the network's own answer over the fallback when it is good", async () => {
    const sw = installed({
      network: new Map([[VARIANT, { ok: true, status: 200, body: "fresh-438w" }]]),
    });
    // The server's own Response is passed through, so this asserts the body
    // rather than the shape: what matters is that it is the network's answer
    // and not the cached master.
    expect((await respond(sw, ORIGIN + VARIANT))?.body).toBe("fresh-438w");
  });

  it("does NOT substitute the plate for any other asset", async () => {
    // The fallback is scoped, and this is the assertion that keeps it scoped:
    // answering an unrelated request with the plate would be a silently WRONG
    // picture, which is worse than a missing one.
    const sw = installed({ offline: true });
    for (const other of [
      "/assets/index-abc123.js",
      "/assets/index-CHGlXcTt.css",
      "/assets/sanpo-corporate-master-approved-v1-Y8xx-dg2.svg",
      // Same stem, different directory — the rule is scoped to /assets/.
      `/img/${STEM}-438w.webp`,
      // Right directory, wrong stem.
      "/assets/some-other-illustration-438w.webp",
      // Right stem, not an image the plate family contains.
      `/assets/${STEM}-438w.js`,
    ]) {
      expect(await respond(sw, ORIGIN + other), `${other} was answered with the plate`).toEqual({
        type: "error",
      });
    }
  });

  it("falls back for the master's own URL too", async () => {
    // The master is precached, so this normally hits the cache. But a worker
    // whose install partially failed (per-URL `allSettled`) can be missing it,
    // and then the fallback lookup is simply a miss rather than a crash.
    const sw = loadServiceWorker({ plateFamily: PLATE, cache: new Map(), offline: true });
    expect(await respond(sw, ORIGIN + MASTER)).toEqual({ type: "error" });
  });

  it("does nothing when the build stamped no plate", async () => {
    // A `public`-only build. The worker must not throw on `PLATE_FAMILY.stem`.
    const sw = loadServiceWorker({ plateFamily: null, offline: true });
    expect(await respond(sw, ORIGIN + VARIANT)).toEqual({ type: "error" });
  });
});

describe("push (review M27)", () => {
  it("always displays a notification, even for a payload it cannot read", async () => {
    // Chrome allows a handful of silent pushes, then shows "This site has been
    // updated in the background" ITSELF, and revokes the permission from
    // repeat offenders. So every path out of the handler must show something:
    // a generic notification is a worse product, no notification is a broken
    // one — and the permission is not recoverable without asking again.
    for (const payload of ["malformed", null, {}, { title: "" }] as const) {
      const h = loadServiceWorker();
      await push(h, payload);
      expect(h.shown.length, `payload ${JSON.stringify(payload)} showed nothing`).toBe(1);
      expect(h.shown[0].title).toBe("Sanpo");
    }
  });

  it("uses the server's title, body and tag when they are there", async () => {
    const h = loadServiceWorker();
    await push(h, { title: "Walk complete", body: "Luna had a great walk.", tag: "walk_complete", url: "/portal/walks/1" });
    expect(h.shown[0].title).toBe("Walk complete");
    expect(h.shown[0].opts.body).toBe("Luna had a great walk.");
    // The tag collapses repeats of one kind rather than stacking a lock screen.
    expect(h.shown[0].opts.tag).toBe("walk_complete");
    expect(h.shown[0].opts.data).toEqual({ url: "/portal/walks/1" });
  });

  it("refuses an off-origin destination in the payload", async () => {
    // The M41 open-redirect rule, at a sink that is a real navigation. The
    // payload is written by our own server today — the kind of property that
    // quietly stops being true.
    for (const url of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "walks/1", "/\tevil"]) {
      const h = loadServiceWorker();
      await push(h, { title: "x", url });
      expect((h.shown[0].opts.data as { url: string }).url, `accepted ${url}`).toBe("/");
    }
  });

  it("a tap focuses an open tab rather than stacking another", async () => {
    const h = loadServiceWorker({ openWindows: ["https://app.sanpo.test/calendar"] });
    const { closed } = await click(h, "/portal/walks/1");
    expect(closed).toBe(1);
    expect(h.focused).toEqual(["https://app.sanpo.test/calendar"]);
    expect(h.navigated).toEqual(["/portal/walks/1"]);
    expect(h.opened).toEqual([]);
  });

  it("a tap with nothing open opens a window at the deep link", async () => {
    const h = loadServiceWorker({ openWindows: [] });
    await click(h, "/portal/walks/1");
    expect(h.opened).toEqual(["/portal/walks/1"]);
  });

  it("a tap never navigates off-origin, and never to a foreign tab", async () => {
    const h = loadServiceWorker({ openWindows: ["https://evil.example/app"] });
    await click(h, "//evil.example");
    expect(h.focused, "focused a tab on another origin").toEqual([]);
    expect(h.opened).toEqual(["/"]);
  });
});
