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

/** `grant|revoke <privs> [(cols)] on <table> to|from <roles>` */
const RE =
  /^(grant|revoke) ([a-z, ]*?) ?(\(([^)]*)\))? ?on (?:table )?([a-z_][a-z0-9_.]*) (?:to|from) ([a-z_, ]+)$/;

interface GrantState {
  /** A table-level SELECT covers every column, including ones added later. */
  tableLevel: boolean;
  /** Columns granted individually. */
  columns: Set<string>;
}

/**
 * Statements, not lines: `0038`'s grant list spans several of them, and a
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

/**
 * Statements this parser SHOULD have understood and did not.
 *
 * Skipping silently is how a guard keeps passing while the thing it guards
 * drifts: a later migration withholding one more column with a form the regex
 * misses would leave the modelled grants stale and the drift test green. So
 * the miss is an assertion rather than a `continue`.
 */
function unparsedRelationGrants(): string[] {
  const missed: string[] = [];
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    for (const stmt of statementsOf(readFileSync(join(MIGRATIONS, file), "utf8"))) {
      if (!/^(grant|revoke) /.test(stmt)) continue;
      // Only relation-level privileges are modelled here; EXECUTE on a
      // function, USAGE on a schema and the rest are a different grammar.
      if (/ on (function|schema|sequence|type|domain|language|database|tablespace|foreign) /.test(stmt)) continue;
      if (/ on all /.test(stmt)) continue;
      // Split the privilege list off at " on " and look for SELECT as a token.
      // The first version of this asked for / select / with spaces on both
      // sides, which silently skipped every `grant select, insert, ...` — the
      // multi-privilege form, i.e. exactly the statements most likely to defeat
      // the parser. A guard that cannot fail is the thing this guard is about,
      // so the sabotage that found it is kept as the test below.
      const split = /^(?:grant|revoke) (.+?) on .+$/.exec(stmt);
      if (!split || !/\b(select|all)\b/.test(split[1])) continue;
      if (!RE.test(stmt)) missed.push(`${file}: ${stmt.slice(0, 110)}`);
    }
  }
  return missed;
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

/**
 * The first argument of the next `.select(` — captured with a balanced scan.
 *
 * A `/\.select\(([^)]*)\)/` stops at the FIRST `)`, so
 * `.select("*, client:clients(*)")` yields the truncated `"*, client:clients(*`
 * and the embed inside it is never seen. That is the exact query this guard
 * exists to catch, so the cheap regex was a hole in the middle of it.
 */
export function firstSelectArg(region: string): string | null {
  const at = region.indexOf(".select(");
  if (at === -1) return null;
  let depth = 0;
  let quote: string | null = null;
  let out = "";
  for (let i = at + ".select(".length; i < region.length; i++) {
    const ch = region[i];
    if (quote) {
      if (ch === quote && region[i - 1] !== "\\") quote = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") {
      if (depth === 0) return out.trim();
      depth--;
    }
    // Only the FIRST argument: `.select(cols, { head: true })` must not let an
    // options object mask the wildcard in front of it.
    if (ch === "," && depth === 0) return out.trim();
    out += ch;
  }
  return out.trim();
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
      const sel = firstSelectArg(region);
      if (sel !== null) found.push({ file, table: m[1], arg: sel });
    }
  }
  return found;
}

/**
 * A wildcard is a wildcard even in company.
 *
 * `.select("*, client:clients(full_name)")` is an idiom this file already uses
 * four times, and the base-table `*` in it expands exactly as a bare one does.
 * An exact string match would pass it — the guard defeated by the first
 * refactor that adds an embed, which is the failure this guard exists to stop.
 *
 * Embedded resources are their own tables and are handled by their own entry
 * in the scan, so everything inside parentheses is dropped before splitting.
 */
/** Top-level terms of a select string, with embeds left intact. */
function topLevelTerms(inner: string): string[] {
  let depth = 0;
  let term = "";
  const terms: string[] = [];
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { terms.push(term); term = ""; continue; }
    term += ch;
  }
  terms.push(term);
  return terms.map((t) => t.trim()).filter(Boolean);
}

const unquote = (arg: string) => arg.trim().replace(/^["'`]|["'`]$/g, "");

/**
 * Embedded resources named in a select, as `[table, innerSelect]`.
 *
 * `client:clients(full_name)` is an embed of `clients` — a table this scan
 * would otherwise never look at, because the query's `.from()` names something
 * else entirely. `client:clients(*)` is one character away and expands to the
 * same `SELECT clients.*` that broke the Clients tab.
 */
export function embedsOf(arg: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const term of topLevelTerms(unquote(arg))) {
    const m = /^(?:[a-z_]+:)?([a-z_]+)\s*\(([\s\S]*)\)$/i.exec(term);
    if (m) {
      out.push([m[1], m[2]]);
      for (const nested of embedsOf(m[2])) out.push(nested);
    }
  }
  return out;
}

/** Column names a select names explicitly at the top level (embeds excluded). */
export function namedColumns(arg: string): string[] {
  return topLevelTerms(unquote(arg))
    .filter((t) => !/\(/.test(t))
    .map((t) => t.replace(/^[a-z_]+:/i, "").trim())
    .filter((t) => t && t !== "*");
}

export function selectsWildcard(arg: string): boolean {
  const inner = unquote(arg);
  if (inner === "") return true; // `.select()` — postgrest-js sends `*`
  return topLevelTerms(inner).some((t) => t === "*");
}

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
    // The statement that first put `clients` into this shape spans several
    // lines. If the parser missed it, `clients` would look table-level and
    // every assertion below would pass while the product stayed broken.
    const cols = columnRestrictedTables().get("clients");
    expect(cols).toBeDefined();
    expect(cols).toContain("full_name");
    expect(cols).toContain("credit_balance");
  });

  it("never selects * from a table with column-level grants", () => {
    const restricted = columnRestrictedTables();
    const short = (f: string) => f.replace(/.*\/src\//, "src/");
    const offenders: string[] = [];
    for (const s of selectsByTable()) {
      if (restricted.has(s.table) && selectsWildcard(s.arg)) {
        offenders.push(`${short(s.file)}: .from("${s.table}").select(${s.arg || ""})`);
      }
      // An EMBED of a restricted table expands the same way, and the query's
      // own `.from()` names something else — so nothing else in this file
      // would look at it. `client:clients(full_name)` appears four times in
      // api.ts already; `client:clients(*)` is one character away.
      for (const [table, innerSel] of embedsOf(s.arg)) {
        if (restricted.has(table) && selectsWildcard(innerSel)) {
          offenders.push(`${short(s.file)}: embed ${table}(${innerSel})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never names a column the grants withhold", () => {
    // The other half of the same question. A wildcard is the loud way to ask
    // for an ungranted column; naming one explicitly is the quiet way, and it
    // fails identically. `previewInvite` is the one `clients` read that does
    // not go through CLIENT_COLUMNS, and its return type is still keyed off
    // the un-narrowed `Clients`, so widening it would compile cleanly.
    const restricted = columnRestrictedTables();
    const offenders: string[] = [];
    const check = (file: string, table: string, arg: string) => {
      const granted = restricted.get(table);
      if (!granted) return;
      for (const col of namedColumns(arg)) {
        if (!granted.has(col)) {
          offenders.push(`${file.replace(/.*\/src\//, "src/")}: ${table}.${col}`);
        }
      }
    };
    for (const s of selectsByTable()) {
      if (s.arg.startsWith('"') || s.arg.startsWith("'")) check(s.file, s.table, s.arg);
      for (const [table, innerSel] of embedsOf(s.arg)) check(s.file, table, innerSel);
    }
    expect(offenders).toEqual([]);
  });

  it("understands every relation grant in the migrations", () => {
    // The drift test derives its expectation from this parser, so a statement
    // the parser cannot read is a silent hole in the check, not a no-op.
    expect(unparsedRelationGrants()).toEqual([]);
  });

  it("treats a wildcard as a wildcard even beside an embed", () => {
    expect(selectsWildcard('"*"')).toBe(true);
    expect(selectsWildcard("")).toBe(true);
    // The idiom api.ts already uses — the base-table `*` expands the same way.
    expect(selectsWildcard('"*, client:clients(full_name)"')).toBe(true);
    expect(selectsWildcard('"pets(*), id"')).toBe(false); // the embed is its own table
    expect(selectsWildcard('"id, full_name"')).toBe(false);
    expect(selectsWildcard("CLIENT_COLUMNS")).toBe(false);
  });

  it("captures a select argument containing parentheses", () => {
    // The cheap regex truncated at the first `)`, which is precisely where an
    // embed opens — so the guard read `"*, client:clients(*` and saw nothing.
    expect(firstSelectArg('.select("*, client:clients(*)")')).toBe('"*, client:clients(*)"');
    expect(firstSelectArg('.select(CLIENT_COLUMNS)')).toBe("CLIENT_COLUMNS");
    expect(firstSelectArg('.select("id", { head: true })')).toBe('"id"');
    expect(firstSelectArg(".select()")).toBe("");
  });

  it("sees an embedded restricted table that the .from() never mentions", () => {
    expect(embedsOf('"*, client:clients(full_name)"')).toEqual([["clients", "full_name"]]);
    expect(embedsOf('"*, client:clients(*)"')).toEqual([["clients", "*"]]);
    expect(namedColumns('"id, full_name, client:clients(x)"')).toEqual(["id", "full_name"]);
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
