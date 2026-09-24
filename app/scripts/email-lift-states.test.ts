import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_LIFT_RESULTS, EMAIL_LIFT_STATES } from "../src/lib/email-lift-states.js";

/**
 * 0054's states are written twice: as the CASE in `fn_email_lift_decision`
 * and as `EMAIL_LIFT_STATES`, which the portal branches on. A state the server
 * can answer and the page does not know makes the page throw and say nothing,
 * and a state the page knows and the server never answers is a sentence
 * nobody will ever see. The wrapper tests iterate the TypeScript list against
 * itself, so they cannot notice either; this reads the migration.
 *
 * The last definition wins, as it does in the database: a later migration's
 * `create or replace` is what runs (the payment_status_test.ts rule).
 */

const MIGRATIONS = join(import.meta.dirname, "..", "..", "supabase", "migrations");

/** The body of the last definition of a function across the migrations. */
function lastBody(fn: string): string {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const opener = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${fn}\\s*\\(`, "gi");
  let found: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    for (const m of sql.matchAll(opener)) {
      // The body is the first dollar-quoted string after the signature.
      const rest = sql.slice(m.index);
      const open = /\$([a-z_]*)\$/i.exec(rest);
      if (!open) throw new Error(`${fn} in ${f}: no dollar-quoted body after the signature`);
      const tag = open[0];
      const start = open.index + tag.length;
      const end = rest.indexOf(tag, start);
      if (end < 0) throw new Error(`${fn} in ${f}: the body's ${tag} is never closed`);
      found = rest.slice(start, end);
    }
  }
  if (found === null) throw new Error(`no definition of ${fn} in ${MIGRATIONS}`);
  return found;
}

/** Drop `--` comments, which quote state names in prose. */
function code(body: string): string {
  return body.replace(/--[^\n]*/g, "");
}

describe("0054's states, in SQL and in the portal", () => {
  it("the decision answers exactly the portal's states, in the portal's order", () => {
    const body = code(lastBody("fn_email_lift_decision"));
    // Every answer of the CASE: `then '<state>'` and the final `else '<state>'`.
    const answered = [...body.matchAll(/\b(?:then|else)\s+'([a-z_]+)'/g)].map((m) => m[1]!);
    // Eyesight: a parser that read nothing would compare two empty lists.
    expect(answered.length).toBeGreaterThanOrEqual(EMAIL_LIFT_STATES.length);
    const inOrder = answered.filter((s, i) => answered.indexOf(s) === i);
    expect(inOrder).toEqual([...EMAIL_LIFT_STATES]);
  });

  it("the lift answers only what the portal knows", () => {
    const body = code(lastBody("fn_lift_my_email_suppression"));
    // The literal answers sit in its `return query select …;` statements. The
    // refusals pass the decision's own state through (`select v_state, …`),
    // which the test above covers.
    const statements = [...body.matchAll(/return\s+query\s+select\b([\s\S]*?);/gi)].map((m) => m[1]!);
    expect(statements.length).toBeGreaterThan(0);
    const literals = new Set(
      statements.flatMap((s) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)),
    );
    // Eyesight again, on the two answers only the lift gives.
    for (const own of EMAIL_LIFT_RESULTS) expect(literals).toContain(own);
    const known = new Set<string>([...EMAIL_LIFT_RESULTS, ...EMAIL_LIFT_STATES]);
    expect([...literals].filter((l) => !known.has(l))).toEqual([]);
  });
});
