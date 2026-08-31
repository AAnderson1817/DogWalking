// The push-service allowlist exists TWICE, and this is what keeps it once.
//
// `fn_is_push_service_endpoint` (migration 0049) refuses an unknown host at
// registration; `isPushServiceEndpoint` (supabase/functions/_lib/webpush.ts)
// refuses one at send time, which is the check that actually stops the
// `fetch`. Both are wanted — see the comments on each — but a security
// control written down in two places drifts, and this repository has already
// paid for exactly that: `payment_status.ts` exists because two edge
// functions carried their own stale copies of a status set that lived in a
// partial index.
//
// So the SQL is parsed and compared, rather than the lists being asserted
// against a third hand-written copy here. A third copy would need updating
// too, which is the same defect one level up.
//
// This compares the two LISTS, which is what drifts when somebody adds a
// provider. It cannot compare the two ANSWERS — `URL` in Deno against
// `substring()` in Postgres — because a vitest process cannot run PL/pgSQL,
// and that turned out to be the half that mattered: the two disagreed on an
// uppercase scheme and an explicit `:443` the day they were written.
// `scripts/check-push-endpoint-parity.sh` is the gate for that, run from
// validate.sh and the CI database job because it needs a database AND deno.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const SQL = read("../../supabase/migrations/0049_push_subscriptions.sql");
const TS = read("../../supabase/functions/_lib/webpush.ts");

/**
 * The quoted strings of one `array[ ... ]` literal assigned to a declared
 * variable in the SQL function.
 *
 * Anchored on the variable name and on `array[`, and it FAILS rather than
 * returning nothing when either is missing. A parser that answers "no hosts"
 * for a function it could not read reports drift as agreement whenever both
 * sides are empty — the check passing by seeing nothing, which
 * `column-grants.test.ts` had to be fixed for.
 */
function sqlArray(variable: string): string[] {
  const m = new RegExp(`${variable}\\s+text\\[\\]\\s*:=\\s*array\\[([^\\]]*)\\]`).exec(SQL);
  if (!m) throw new Error(`0049 has no array literal assigned to ${variable}`);
  const items = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  if (items.length === 0) throw new Error(`${variable} in 0049 parsed to an empty list`);
  return items;
}

/** The string entries of one exported `readonly string[]` in webpush.ts. */
function tsArray(name: string): string[] {
  const m = new RegExp(
    `export const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\];`,
  ).exec(TS);
  if (!m) throw new Error(`webpush.ts has no exported array named ${name}`);
  const items = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  if (items.length === 0) throw new Error(`${name} in webpush.ts parsed to an empty list`);
  return items;
}

describe("the push-service allowlist is one list", () => {
  it("names the same exact hosts in the migration and the sender", () => {
    expect(sqlArray("v_hosts").slice().sort()).toEqual(tsArray("PUSH_SERVICE_HOSTS").slice().sort());
  });

  it("names the same host suffixes in the migration and the sender", () => {
    expect(sqlArray("v_suffixes").slice().sort()).toEqual(
      tsArray("PUSH_SERVICE_HOST_SUFFIXES").slice().sort(),
    );
  });

  it("keeps every suffix dot-prefixed, in both", () => {
    // Without the leading dot, `notify.windows.com` also admits
    // `evilnotify.windows.com` — a registrable domain. This is the one
    // property of an entry that is not visible by reading it next to its
    // sibling, so it is asserted rather than reviewed.
    for (const suffix of [...sqlArray("v_suffixes"), ...tsArray("PUSH_SERVICE_HOST_SUFFIXES")]) {
      expect(suffix.startsWith(".")).toBe(true);
    }
  });

  it("registers through the predicate rather than re-testing the scheme", () => {
    // The registration RPC must CALL the shared predicate. Re-deriving the
    // rule inline is how the two lists stop being one list, and it is not
    // something the comparisons above can see.
    expect(SQL).toMatch(/if not fn_is_push_service_endpoint\(p_endpoint\) then/);
  });

  it("refuses to POST to an endpoint the predicate rejects", () => {
    // Same argument on the send side: `deliverPush` must consult the
    // predicate, not merely import it.
    const push = read("../../supabase/functions/send-notification/push.ts");
    expect(push).toMatch(/if \(!isPushServiceEndpoint\(sub\.endpoint\)\) \{/);
  });
});
