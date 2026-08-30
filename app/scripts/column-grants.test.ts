import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A wildcard select against a table with column-level grants is a 42501.
 *
 * PostgREST does not narrow `select=*` to the columns the caller may read. It
 * emits `SELECT <table>.*`, and Postgres refuses the whole statement if ANY
 * column in that expansion is ungranted — so a single withheld column does not
 * hide a field, it takes every row of every query on that table with it. And
 * `.select()` with no argument is a wildcard: postgrest-js 2.110.0 does
 * `const cleanedColumns = (columns ?? '*')` (src/PostgrestQueryBuilder.ts).
 *
 * `clients` acquired that shape in `0038`, which withheld `unsubscribe_token`
 * (a bearer credential for "stop emailing this address"), and `0043` §2 added
 * `notes`, `stripe_customer_id` and `stripe_subscription_id`. From `0038` on,
 * six queries in `api.ts` were asking for `*` — `listClients`, `getClient`,
 * `createClient`, `updateClient`, `getMyClient` and `listLowCreditClients` —
 * which is the operator's Clients tab, the client record, adding a client, the
 * low-credit strip and every screen of the client portal.
 *
 * The rule was not unknown. `api.ts` states it above `CRED_META`, for
 * `access_credentials` only ("never select * ... a wildcard select would be
 * denied"), and `smoke.sql` states it again — "`select("*")` starts failing
 * with a bare 42501 from PostgREST" — in the comment above a check that then
 * EXEMPTS the four withheld columns by name. Both halves were written down and
 * neither was connected to the queries. Nothing executable joined them, which
 * is what this file is.
 *
 * The grant state is derived from the migrations rather than restated here, so
 * a future `revoke select (…)` on any table starts failing the build instead of
 * production.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "..", "supabase", "migrations");
const API = join(import.meta.dirname, "..", "src", "lib", "api.ts");
const APP_SRC = join(import.meta.dirname, "..", "src");

/**
 * Read out of the source rather than imported.
 *
 * `api.ts` reaches `window` and resolves its imports the bundler's way, so
 * pulling it into this project (`tsconfig.node.json`, `moduleResolution:
 * nodenext`) fails to typecheck — which is why `platform-price.test.ts` imports
 * a leaf module and this one reads text, as `bounded-queries.test.ts` does for
 * the same file.
 */
function clientColumnsLiteral(): string[] {
  const src = readFileSync(API, "utf8");
  const m = /export const CLIENT_COLUMNS\s*=\s*\n?\s*"([^"]+)"\s*as const;/.exec(src);
  // A regex that silently matches nothing is how a guard passes for the wrong
  // reason, so the miss is an explicit failure rather than an empty list.
  expect(m, "CLIENT_COLUMNS literal not found in api.ts").not.toBeNull();
  return m![1].split(",").map((c) => c.trim());
}

/** The API role the browser holds. `anon` never reads tenant data. */
const ROLE = "authenticated";

interface GrantState {
  /** A table-level SELECT covers every column, including ones added later. */
  tableLevel: boolean;
  /** Columns granted individually. */
  columns: Set<string>;
}

/**
 * Statements, not lines: `0038`'s grant list spans five lines, and a
 * line-oriented parser reads it as no grant at all — which would make this
 * check pass by seeing nothing, the failure mode it exists to catch.
 */
function statementsOf(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
}

/** SELECT grants for ROLE, replayed in migration order. */
function grantStateFromMigrations(): Map<string, GrantState> {
  const state = new Map<string, GrantState>();
  const get = (t: string): GrantState => {
    let s = state.get(t);
    if (!s) {
      s = { tableLevel: false, columns: new Set() };
      state.set(t, s);
    }
    return s;
  };

  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  expect(files.length).toBeGreaterThan(0);

  // `grant|revoke <privs> [(cols)] on <table> to|from <roles>`
  const RE =
    /^(grant|revoke) ([a-z, ]*?) ?(\(([^)]*)\))? ?on (?:table )?([a-z_][a-z0-9_.]*) (?:to|from) ([a-z_, ]+)$/;

  for (const file of files) {
    for (const stmt of statementsOf(readFileSync(join(MIGRATIONS, file), "utf8"))) {
      const m = RE.exec(stmt);
      if (!m) continue;
      const [, verb, privRaw, , colRaw, table, roleRaw] = m;
      const roles = roleRaw.split(",").map((r) => r.trim());
      if (!roles.includes(ROLE)) continue;

      const privs = privRaw.split(",").map((p) => p.trim()).filter(Boolean);
      const touchesSelect = privs.includes("select") || privs.includes("all");
      if (!touchesSelect) continue;

      const target = get(table);
      const cols = colRaw?.split(",").map((c) => c.trim()).filter(Boolean);

      if (verb === "grant") {
        if (cols) cols.forEach((c) => target.columns.add(c));
        else target.tableLevel = true;
      } else if (cols) {
        cols.forEach((c) => target.columns.delete(c));
      } else {
        // Revoking a table-level privilege revokes it for every column too.
        target.tableLevel = false;
        target.columns.clear();
      }
    }
  }
  return state;
}

/** Tables ROLE may read only column-by-column — where `*` is a 42501. */
function columnRestrictedTables(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [table, s] of grantStateFromMigrations()) {
    if (!s.tableLevel && s.columns.size > 0) out.set(table, s.columns);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Every `from("<table>") … .select(<arg>)` reachable in the app source. */
function selectsByTable(): Array<{ file: string; table: string; arg: string }> {
  const found: Array<{ file: string; table: string; arg: string }> = [];
  for (const file of sourceFiles(APP_SRC)) {
    const src = readFileSync(file, "utf8");
    const from = /\.from\(\s*"([a-z_]+)"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = from.exec(src))) {
      // The first `.select(` after this `.from(` and before the next one.
      const nextFrom = src.indexOf('.from("', m.index + 1);
      const region = src.slice(m.index, nextFrom === -1 ? undefined : nextFrom);
      const sel = /\.select\(([^)]*)\)/.exec(region);
      if (sel) found.push({ file, table: m[1], arg: sel[1].trim() });
    }
  }
  return found;
}

const isWildcard = (arg: string) => arg === "" || arg === '"*"' || arg === "'*'";

describe("column-level SELECT grants and wildcard selects", () => {
  it("finds the tables whose SELECT is column-restricted", () => {
    // A guard that matched nothing would pass for the wrong reason. These two
    // are the whole set today, and both are deliberate: invariant 2 withholds
    // the vault ciphertext, 0038/0043 withhold the four client columns.
    expect([...columnRestrictedTables().keys()].sort()).toEqual([
      "access_credentials",
      "clients",
    ]);
  });

  it("parses 0038's multi-line grant rather than skipping it", () => {
    // The statement that first put `clients` into this shape spans five lines.
    // If the parser missed it, `clients` would look table-level and every
    // assertion below would pass while the product stayed broken.
    const cols = columnRestrictedTables().get("clients");
    expect(cols).toBeDefined();
    expect(cols).toContain("full_name");
    expect(cols).toContain("credit_balance");
  });

  it("never selects * from a table with column-level grants", () => {
    const restricted = columnRestrictedTables();
    const offenders = selectsByTable()
      .filter((s) => restricted.has(s.table) && isWildcard(s.arg))
      .map((s) => `${s.file.replace(/.*\/src\//, "src/")}: .from("${s.table}").select(${s.arg || ""})`);
    expect(offenders).toEqual([]);
  });

  it("CLIENT_COLUMNS names exactly the columns the grants allow", () => {
    const granted = columnRestrictedTables().get("clients");
    expect(granted).toBeDefined();
    const listed = clientColumnsLiteral();

    // Both directions, the smoke suite's idiom for the same grant. A column
    // granted later and left out of the list is invisible to the product; one
    // listed but never granted is a 42501 on every query of the table.
    expect(listed.filter((c: string) => !granted!.has(c))).toEqual([]);
    expect([...granted!].filter((c: string) => !listed.includes(c)).sort()).toEqual([]);
  });

  it("lists each column once", () => {
    const listed = clientColumnsLiteral();
    expect(listed.length).toBe(new Set(listed).size);
  });
});
