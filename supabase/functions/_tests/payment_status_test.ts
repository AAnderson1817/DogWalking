// The status sets in TypeScript must equal the ones Postgres actually indexes.
//
// `payments` carries two PARTIAL unique indexes, each filtered on `status`. A
// row participates in its own uniqueness guarantee only while its status is in
// that set, so every "has this already been paid?" query in the edge functions
// is re-asking a question the index has already answered. When the two sets
// disagree the failure is silent in one direction and unexplained in the other:
// too narrow and the query misses a row, the caller inserts, and the index
// raises an error the operator reads as "internal error"; too wide and the
// caller declines to act on a row the database would let it duplicate.
//
// This is exactly what happened. 0023 widened both indexes to keep a reversal
// from unlocking a second charge, and the two reads in the edge functions kept
// the old, narrower lists.
//
// So the assertion is not "the list is [a, b, c]" — that just restates the
// code. It parses the LAST definition of each index out of the migrations and
// compares. Change either side alone and this fails.
import { assert, assertEquals } from "./asserts.ts";
import {
  OVERAGE_CLAIM_STATUSES,
  SUBSCRIPTION_INVOICE_STATUSES,
} from "../_lib/payment_status.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

/**
 * Every `create unique index <name> ... where <predicate>;` in the migrations,
 * in file order, so the LAST one wins — a later migration that drops and
 * recreates an index is the definition that is live.
 */
async function livePredicate(indexName: string): Promise<string> {
  const files: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  }
  files.sort();

  let found: string | null = null;
  const re = new RegExp(
    `create\\s+unique\\s+index(?:\\s+if\\s+not\\s+exists)?\\s+${indexName}\\b([\\s\\S]*?);`,
    "gi",
  );
  for (const name of files) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS));
    for (const m of sql.matchAll(re)) found = m[1];
  }
  assert(found !== null, `no create unique index for ${indexName} in any migration`);
  return found!;
}

/** The `status in ('a', 'b')` list out of an index predicate. */
function statusesIn(predicate: string): string[] {
  const m = predicate.match(/status\s+in\s*\(([^)]*)\)/i);
  assert(m, `index predicate has no status filter: ${predicate.trim()}`);
  return m![1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter((s) => s.length > 0)
    .sort();
}

Deno.test("OVERAGE_CLAIM_STATUSES equals what uq_overage_payment_per_walk indexes", async () => {
  const sql = statusesIn(await livePredicate("uq_overage_payment_per_walk"));
  assertEquals(
    [...OVERAGE_CLAIM_STATUSES].sort(),
    sql,
    "getLiveOveragePayment would miss a row the index still enforces, or block on one it does not",
  );
});

Deno.test("SUBSCRIPTION_INVOICE_STATUSES equals what uq_payments_subscription_invoice indexes", async () => {
  const sql = statusesIn(await livePredicate("uq_payments_subscription_invoice"));
  assertEquals(
    [...SUBSCRIPTION_INVOICE_STATUSES].sort(),
    sql,
    "hasPaymentForInvoice and the index disagree about what counts as already paid",
  );
});

Deno.test("'failed' is in neither set — a declined charge stays re-chargeable", async () => {
  // Stated as its own test because it is the one value whose exclusion is a
  // product decision rather than a mechanical consequence: a card decline has
  // to leave the walk chargeable again, and invoice.payment_failed has to be
  // able to write a row beside a later success on the same invoice.
  assert(!(OVERAGE_CLAIM_STATUSES as readonly string[]).includes("failed"));
  assert(!(SUBSCRIPTION_INVOICE_STATUSES as readonly string[]).includes("failed"));
});

Deno.test("the parser reads the LAST definition, not the first", async () => {
  // 0012 created uq_overage_payment_per_walk and 0023 dropped and recreated it
  // wider. If this parser took the first match the whole file would assert the
  // superseded predicate and pass while the code was wrong — the same
  // false-assurance shape as a typecheck that checks zero files.
  const predicate = await livePredicate("uq_overage_payment_per_walk");
  const statuses = statusesIn(predicate);
  assert(
    statuses.includes("refunded") && statuses.includes("disputed"),
    "parsed the pre-0023 definition: " + statuses.join(", "),
  );
});
