import { assert, assertEquals } from "./asserts.ts";

/**
 * Review L8. `create-checkout` has no injected handler seam — it builds one
 * Stripe call and returns the URL — so this reads the source rather than
 * driving the code. That is the same idiom as `payment_status_test.ts`, which
 * parses the migrations rather than restating them, and it is why this suite's
 * read permission now covers `supabase/functions` as well.
 *
 * The rule worth pinning is not "we collect an address". It is that collecting
 * one and keeping one are two different options, and Stripe's default is to
 * collect it for the payment and NOT write it back to the Customer. A session
 * with `billing_address_collection` and no `customer_update.address` therefore
 * asks every client for their address and then throws it away — indis-
 * tinguishable, six months later, from never having asked, except that the
 * form was longer. The whole point of L8 is having the address on the Customer
 * when Stripe Tax is eventually turned on.
 */
const SRC = await Deno.readTextFile(
  new URL("../create-checkout/index.ts", import.meta.url),
);

/** The session object, from `checkout.sessions.create({` to its matching brace. */
function sessionOptions(): string {
  const at = SRC.indexOf("checkout.sessions.create({");
  assert(at > -1, "create-checkout no longer calls checkout.sessions.create");
  const open = SRC.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(open, i + 1);
  }
  throw new Error("unbalanced session options");
}

Deno.test("checkout collects a billing address", () => {
  assert(
    /billing_address_collection:\s*"required"/.test(sessionOptions()),
    "the session no longer requires a billing address (review L8)",
  );
});

Deno.test("an address that is collected is also persisted to the Customer", () => {
  const opts = sessionOptions();
  const collects = /billing_address_collection:\s*"(required|auto)"/.test(opts);
  const persists = /customer_update:\s*\{[^}]*address:\s*"auto"/.test(opts);
  assertEquals(
    collects && !persists,
    false,
    "billing_address_collection without customer_update.address collects the "
      + "address for the payment and never writes it to the Customer — the "
      + "address is asked for and discarded",
  );
});

Deno.test("the source parser found the real call", () => {
  // Without this, both assertions above would pass vacuously against an empty
  // string if `sessionOptions()` ever started returning one.
  const opts = sessionOptions();
  assert(opts.includes("mode:"), "parsed something that is not the session options");
  assert(opts.length > 200, `session options implausibly short (${opts.length})`);
});
