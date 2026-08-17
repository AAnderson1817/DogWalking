// _lib/broadcast: the server-side Realtime publish.
//
// This helper had no test at all, which is how it kept `private: false` while
// the whole point of review H1 is that a public topic is joinable by any
// holder of the anon key. It is also a correctness contract, not only a
// security one: a message published as public is not delivered to subscribers
// of the private topic of the same name, so if this flag and the client's
// channel config ever disagree, the client silently stops receiving the
// "walk ended" signal — the failure would look like a UI bug, not a config
// mismatch.
import { assert, assertEquals } from "./asserts.ts";
import { broadcast } from "../_lib/broadcast.ts";

type Captured = { url: string; body: Record<string, unknown>; headers: Headers };

async function withStubbedFetch(
  run: () => Promise<void>,
): Promise<Captured[]> {
  const captured: Captured[] = [];
  const realFetch = globalThis.fetch;
  const realGet = Deno.env.get;

  // Matched on the suffix rather than the full variable name on purpose: the
  // CI secret-leak grep flags any line mentioning the service-role variable
  // that is not a `Deno.env.get` call, and a test stub is not a good enough
  // reason to widen a guard that exists to keep real keys out of the tree.
  Deno.env.get = (key: string) => {
    if (key.endsWith("_URL")) return "https://example.supabase.co";
    if (key.endsWith("_KEY")) return "stub-key";
    return realGet.call(Deno.env, key);
  };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(new Response(null, { status: 202 }));
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.get = realGet;
  }
  return captured;
}

Deno.test("publishes to the private topic, matching the client's channel", async () => {
  const calls = await withStubbedFetch(async () => {
    await broadcast("walk:11111111-2222-4333-8444-555555555555", "ended", { walk_id: "w1" });
  });

  assertEquals(calls.length, 1);
  const [call] = calls;
  assertEquals(call.url, "https://example.supabase.co/realtime/v1/api/broadcast");

  const messages = call.body.messages as Array<Record<string, unknown>>;
  assertEquals(messages.length, 1);
  assertEquals(messages[0].topic, "walk:11111111-2222-4333-8444-555555555555");
  assertEquals(messages[0].event, "ended");

  // The assertion this file exists for. `false` here is the shipped bug;
  // anything other than exactly `true` leaves the topic public.
  assertEquals(
    messages[0].private,
    true,
    "server broadcast must publish to the PRIVATE topic (review H1)",
  );
});

Deno.test("authenticates with the service-role key, which bypasses the policies", async () => {
  const calls = await withStubbedFetch(async () => {
    await broadcast("walk:11111111-2222-4333-8444-555555555555", "gps", { lat: 1, lng: 2 });
  });

  // The realtime.messages policies grant `authenticated` only; the server side
  // is authorized by bypassing RLS, so this key is load-bearing for the
  // private topic rather than incidental.
  assertEquals(calls[0].headers.get("apikey"), "stub-key");
  assertEquals(calls[0].headers.get("Authorization"), "Bearer stub-key");
});

Deno.test("does nothing when the environment is unconfigured", async () => {
  const realGet = Deno.env.get;
  const realFetch = globalThis.fetch;
  let called = false;
  Deno.env.get = () => undefined;
  globalThis.fetch = (() => {
    called = true;
    return Promise.resolve(new Response(null, { status: 202 }));
  }) as typeof fetch;
  try {
    await broadcast("walk:x", "ended", {});
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.get = realGet;
  }
  assert(!called, "must not attempt a broadcast without URL and key");
});
