// Reading a function's current definition out of supabase/migrations, for
// tests that hold app code to what the database says. The LAST definition is
// the one a deployed database runs: a first-match reader would read a body a
// later migration replaced, which is how payment_status_test once confirmed
// the very bug it was written for.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");

/**
 * The body of the last `create [or replace] function <name>(` in the
 * migrations, between its dollar quotes. Throws rather than returning
 * nothing: a reader that found no definition would let a comparison agree
 * with an empty answer.
 */
export function lastFunctionBody(name: string): string {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let last: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    const head = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${name}\\s*\\(`, "gi");
    let m: RegExpExecArray | null;
    while ((m = head.exec(sql)) !== null) {
      const from = sql.slice(m.index);
      const open = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(from);
      if (!open) throw new Error(`${f}: ${name} has no dollar-quoted body this reader can find`);
      const start = open.index + open[0].length;
      const end = from.indexOf(open[1]!, start);
      if (end < 0) throw new Error(`${f}: ${name}'s body is never closed`);
      last = from.slice(start, end);
    }
  }
  if (last === null) throw new Error(`no definition of ${name} in supabase/migrations`);
  return last;
}

/**
 * The plain SQL string literals of the argument list whose `(` is at `open`,
 * read as SQL reads them (a doubled quote is one quote). Anything else in the
 * list is refused by name rather than skipped.
 */
export function sqlLiteralList(text: string, open: number): string[] {
  if (text[open] !== "(") throw new Error("sqlLiteralList: not at an opening parenthesis");
  const out: string[] = [];
  let i = open + 1;
  for (;;) {
    while (/[\s,]/.test(text[i] ?? "")) i++;
    if (text[i] === ")") return out;
    if (text[i] !== "'") throw new Error(`a list of literals holds something else, at: ${text.slice(i, i + 40)}`);
    let value = "";
    for (i++; ; i++) {
      if (i >= text.length) throw new Error("an unterminated literal");
      if (text[i] === "'") {
        if (text[i + 1] === "'") { value += "'"; i++; continue; }
        i++;
        break;
      }
      value += text[i];
    }
    out.push(value);
  }
}
