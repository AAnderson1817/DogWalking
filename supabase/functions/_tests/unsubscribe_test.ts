import { assert, assertEquals } from "./asserts.ts";
import { handleRequest } from "../_lib/http.ts";
import { handleUnsubscribe, type UnsubscribeDeps } from "../unsubscribe/handler.ts";

// The endpoint M29 shipped had no test of its own: only the send side, which
// builds the link, was covered. So nothing exercised the request an actual
// recipient makes, and `serveFunction`'s POST-only gate answered every click
// with 405 while the handler underneath was correct. Every test here that
// goes through `handleRequest` rather than straight to the handler exists
// because of that: the gate is the part that was wrong.

const TOKEN = "11111111-2222-4333-8444-555555555555";

function deps(over: Partial<UnsubscribeDeps> = {}): UnsubscribeDeps & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    suppress: async (token: string) => {
      seen.push(token);
      return await Promise.resolve(undefined);
    },
    ...over,
  } as UnsubscribeDeps & { seen: string[] };
}

const serve = (req: Request, d: UnsubscribeDeps) =>
  handleRequest(req, (r) => handleUnsubscribe(r, d), { methods: ["GET", "POST"] });

Deno.test("a person clicking the link in their email gets the confirmation page", async () => {
  // The regression test. Against the shipped wrapper this is 405 with a JSON
  // envelope, for every recipient, on the one action the endpoint exists for.
  const d = deps();
  const res = await serve(new Request(`https://fn.test/functions/v1/unsubscribe?t=${TOKEN}`), d);
  assertEquals(res.status, 200);
  assert((res.headers.get("content-type") ?? "").includes("text/html"));
  assert((await res.text()).includes("You're unsubscribed"));
  assertEquals(d.seen, [TOKEN]);
});

Deno.test("one-click POST records it and answers bare 200", async () => {
  const d = deps();
  const res = await serve(
    new Request(`https://fn.test/functions/v1/unsubscribe?t=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }),
    d,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "");
  assertEquals(d.seen, [TOKEN]);
});

Deno.test("a method nobody sends is still refused", async () => {
  // Widening to GET must not widen to everything: the opt-in is a list, not a
  // switch.
  const res = await serve(
    new Request(`https://fn.test/functions/v1/unsubscribe?t=${TOKEN}`, { method: "DELETE" }),
    deps(),
  );
  assertEquals(res.status, 405);
});

Deno.test("every other function stays POST-only", async () => {
  // The default is what protects the money paths. A GET that reached a handler
  // would be a cache-able, link-able, prefetchable charge.
  const res = await handleRequest(
    new Request("https://fn.test/functions/v1/complete-walk"),
    () => Promise.resolve(new Response("reached the handler")),
  );
  assertEquals(res.status, 405);
  const body = await res.json();
  assertEquals(body.error.code, "method_not_allowed");
});

Deno.test("no token at all: the same page, and nothing is written", async () => {
  // This is also the shape of the deploy-time boot probe (review M4), so it
  // has to stay free of side effects: a GET with no `t` must never reach the
  // database.
  const d = deps();
  const res = await serve(new Request("https://fn.test/functions/v1/unsubscribe"), d);
  assertEquals(res.status, 200);
  assert((await res.text()).includes("You're unsubscribed"));
  assertEquals(d.seen, []);
});

Deno.test("a malformed token is refused before the database, not by it", async () => {
  const d = deps();
  const res = await serve(new Request("https://fn.test/functions/v1/unsubscribe?t=not-a-uuid"), d);
  assertEquals(res.status, 200);
  assertEquals(d.seen, []);
});

Deno.test("an unknown token is indistinguishable from a known one", async () => {
  // The oracle rule. Both answer with the same page and the same status.
  const known = await serve(
    new Request(`https://fn.test/functions/v1/unsubscribe?t=${TOKEN}`),
    deps(),
  );
  const unknown = await serve(
    new Request("https://fn.test/functions/v1/unsubscribe?t=99999999-9999-4999-8999-999999999999"),
    deps({ suppress: () => Promise.resolve(undefined) }),
  );
  assertEquals(known.status, unknown.status);
  assertEquals(await known.text(), await unknown.text());
});

Deno.test("a failed write is a 500, never a cheerful page", async () => {
  const res = await serve(
    new Request(`https://fn.test/functions/v1/unsubscribe?t=${TOKEN}`),
    deps({ suppress: () => Promise.resolve({ error: { message: "boom" } }) }),
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error.code, "db_error");
});
