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
}

function loadServiceWorker(): SwHarness {
  const handlers: Handlers = {};
  const added: string[] = [];
  const reject = new Set<string>();
  let skipWaitingCalls = 0;
  const source = SW_SOURCE
    .replace('"__BUILD_VERSION__"', JSON.stringify("test"))
    .replace('"__BUILD_ASSETS__"', JSON.stringify(["/assets/index-abc123.js"]));

  const context: Record<string, unknown> = {
    self: {
      addEventListener: (name: string, fn: (e: never) => void) => {
        if (name === "fetch") handlers.fetch = fn as Handlers["fetch"];
        if (name === "install") handlers.install = fn as Handlers["install"];
        if (name === "message") handlers.message = fn as Handlers["message"];
      },
      location: { origin: "https://app.sanpo.test" },
      skipWaiting: () => {
        skipWaitingCalls += 1;
      },
      clients: { claim: () => Promise.resolve() },
    },
    caches: {
      open: () =>
        Promise.resolve({
          match: () => Promise.resolve(undefined),
          put: () => undefined,
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
    fetch: () => Promise.resolve({ ok: true, clone: () => ({}) }),
    URL,
    Response: { error: () => ({}) },
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
    get skipWaitingCalls() {
      return skipWaitingCalls;
    },
  } as SwHarness;
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
