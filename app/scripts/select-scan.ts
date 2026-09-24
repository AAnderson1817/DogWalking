/**
 * How the two PostgREST gates read the queries the code sends:
 * `column-grants.test.ts` (does a select name a column the grants withhold?)
 * and `select-columns.test.ts` (does it name a column that exists?).
 *
 * A module of its own rather than exports from one of those files, because a
 * test file that imports another test file runs that file's tests again under
 * its own name: `select-columns.test.ts` importing `firstSelectArg` from
 * `column-grants.test.ts` ran all of the grant tests twice, and every vitest
 * count reported since carried the duplicates.
 */

/**
 * The first argument of the next `.select(` — captured with a balanced scan.
 *
 * A `/\.select\(([^)]*)\)/` stops at the FIRST `)`, so
 * `.select("*, client:clients(*)")` yields the truncated `"*, client:clients(*`
 * and the embed inside it is never seen. That is the exact query the grant
 * gate exists to catch, so the cheap regex was a hole in the middle of it.
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

/**
 * Resolve `.select(COLS)` where COLS is a module-level string const in the
 * same file, including one built by `+`-concatenating literals.
 *
 * Load-bearing rather than a nicety, twice over. `send-notification` selects a
 * const, so without this `select-columns.test.ts` would have skipped the exact
 * query it was written to catch. And `api.ts` reads the entry-code trail
 * through `CRED_LOG`, so without it `column-grants.test.ts` could not see that
 * list name a column 0056 withholds.
 */
export function resolveConst(src: string, name: string): string | null {
  const re = new RegExp(`const\\s+${name}\\s*(?::[^=]+)?=\\s*([\\s\\S]*?);`, "m");
  const m = re.exec(src);
  if (!m) return null;
  const expr = m[1].trim();
  // Only a chain of string literals joined by `+`. Anything else (a call, a
  // template with a hole, an array join) is not statically knowable, and
  // guessing would produce false failures on healthy code.
  const parts = expr.split("+").map((p) => p.trim());
  if (!parts.every((p) => /^(["'`])[^"'`]*\1$/.test(p))) return null;
  return parts.map((p) => p.slice(1, -1)).join("");
}

/**
 * A `.from(` naming a table, with either quote. A backreference, so a
 * mismatched pair (`.from("x')`) names nothing.
 *
 * Double quotes only, as both gates first matched, let a single-quoted
 * `.from('credential_access_log')` walk past them: nothing in this repository
 * enforces a quote style, and the query it hid would be refused at run time
 * with a 42501 that both of the trail's callers swallow into an empty list.
 */
const FROM = /\.from\(\s*(["'])([a-z_]+)\1\s*\)/g;
const NEXT_FROM = /\.from\(\s*["']/g;

/**
 * Every `.from("<table>") … .select(<arg>)` in a source text: the table, and
 * the first argument of the first `.select(` after that `.from(` and before
 * the next one. `arg` is the argument as written (a literal with its quotes,
 * or an identifier); callers decide how to read it.
 */
export function fromSelects(src: string): Array<{ table: string; arg: string }> {
  const found: Array<{ table: string; arg: string }> = [];
  for (const m of src.matchAll(FROM)) {
    NEXT_FROM.lastIndex = m.index + 1;
    const next = NEXT_FROM.exec(src);
    const region = src.slice(m.index, next === null ? undefined : next.index);
    const arg = firstSelectArg(region);
    if (arg !== null) found.push({ table: m[2], arg });
  }
  return found;
}
