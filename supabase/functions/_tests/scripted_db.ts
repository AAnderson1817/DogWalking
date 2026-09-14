// A scripted PostgREST double for driving the REAL deps modules — the part of
// an edge function that reaches the database — under `deno test`.
//
// The recorder doubles the handler tests inject (`makeDeps` in each
// `*_test.ts`) exercise decisions and structurally cannot see what a wiring
// does with a query's error, which filter it applies, or which columns it
// asks for. `send_deps_test.ts` was written against this shape to close that
// blind spot for send-notification; `billing_portal_deps_test.ts` and
// `connect_onboarding_deps_test.ts` share it rather than carrying a third and
// fourth copy that would drift (the `payment_status` lesson, in a test double).
//
// Each `from(table)` yields a thenable builder that records the operation and
// its filters and resolves with the result scripted for `<table>.<op>` — a
// single result, or a LIST consumed in order when one wiring asks the same
// table the same way twice in a flow (the last entry sticks once exhausted).
// Nothing scripted resolves `{ data: null, error: null }`, which is what
// supabase-js returns for an empty `maybeSingle`. `rpc(fn)` resolves the
// result scripted for `rpc:<fn>`.
import { assert } from "./asserts.ts";

export interface Result {
  data: unknown;
  error: unknown;
}

export interface Query {
  table: string;
  op: string;
  arg: unknown;
  filters: Array<[string, string, unknown]>;
}

/** The shape supabase-js resolves a failed PostgREST query with. */
export const PG_ERROR = {
  code: "57014",
  message: "canceling statement due to statement timeout",
  details: null,
  hint: null,
};

export function scriptedDb(results: Record<string, Result | Result[]>) {
  const queries: Query[] = [];
  const rpcs: Array<[string, Record<string, unknown>]> = [];
  const resultFor = (key: string): Result => {
    const scripted = results[key];
    if (scripted === undefined) return { data: null, error: null };
    if (!Array.isArray(scripted)) return scripted;
    // A list is a SEQUENCE: consumed front to back, the last entry repeating.
    return scripted.length > 1 ? scripted.shift()! : scripted[0]!;
  };
  function builder(table: string) {
    const q: Query = { table, op: "", arg: undefined, filters: [] };
    queries.push(q);
    const chain = {
      select(cols: string) {
        q.op = q.op || "select";
        q.arg = q.op === "select" ? cols : q.arg;
        return chain;
      },
      update(patch: Record<string, unknown>) {
        q.op = "update";
        q.arg = patch;
        return chain;
      },
      eq(col: string, val: unknown) {
        q.filters.push(["eq", col, val]);
        return chain;
      },
      is(col: string, val: unknown) {
        q.filters.push(["is", col, val]);
        return chain;
      },
      maybeSingle() {
        return chain;
      },
      then<T>(onFulfilled: (r: Result) => T) {
        return Promise.resolve(resultFor(`${table}.${q.op}`)).then(onFulfilled);
      },
    };
    return chain;
  }
  const db = {
    from: (table: string) => builder(table),
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push([fn, args]);
      return Promise.resolve(resultFor(`rpc:${fn}`));
    },
  };
  return { db, queries, rpcs };
}

/** Runs `fn`, returns what it rejected with, and fails if it resolved. */
export async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  const err = await fn().then(() => null, (e: unknown) => e);
  assert(err !== null, "expected a rejection, got a resolved value");
  return err;
}
