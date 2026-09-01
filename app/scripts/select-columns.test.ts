// Every column named in a `.select()` must actually exist.
//
// ── Why this file exists ─────────────────────────────────────────────────
//
// `send-notification` selected `email_delivery_status` from `notifications`
// from `security(0032)` until M27. That is the name of the ENUM TYPE 0029
// created; the COLUMN is `email_status`. PostgREST resolves the select list
// against the real table, so every lookup answered
//
//   {"code":"42703","message":"column notifications.email_delivery_status does not exist"}
//
// and the function's `getNotification` turned that into a 500 — which means
// the Database Webhook's call failed on every notification, and the send-once
// guard added by M1 read an `undefined` field it could never receive.
//
// Nothing could see it. `smoke.sql` goes through psql, so it never builds a
// PostgREST select list; the edge tests inject mocked deps, so they exercise
// the decision logic and never the query; and the fixtures asserted the
// invented shape rather than a captured one, which is the same defect that
// left `check-auth-posture.sh` permanently red while its own suite was green.
//
// This is the SECOND instance of the class — `fix(client-columns)` was the
// first, where `select("*")` on a column-restricted table raised 42501 for
// every row. That one produced `column-grants.test.ts`, which asks whether a
// select is a WILDCARD. This one asks whether the columns it names are REAL.
//
// The schema model is replayed from the migrations rather than from a running
// database on purpose: this has to fail in CI, on a checkout, with no
// container up.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { firstSelectArg } from "./column-grants.test.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const SCAN_DIRS = [join(ROOT, "app", "src"), join(ROOT, "supabase", "functions")];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Statements, comment-stripped. Comments discuss columns that do not exist. */
function statementsOf(sql: string): string[] {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
}

/**
 * table -> columns, replayed in migration order.
 *
 * Deliberately additive-only: `create table`, `alter table … add column`, and
 * `alter table … rename column`. Migrations are append-only and this project
 * has never dropped a column, so a model that only grows matches the tree —
 * and a model that is too PERMISSIVE fails open, which for a guard is the
 * direction that merely misses a defect rather than blocking a healthy build.
 * The counted-tables assertion below is what stops it degrading to "knows
 * nothing, permits everything".
 */
export function tableColumns(): Map<string, Set<string>> {
  const cols = new Map<string, Set<string>>();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  expect(files.length).toBeGreaterThan(0);

  for (const f of files) {
    for (const st of statementsOf(readFileSync(join(MIGRATIONS, f), "utf8"))) {
      const create = /^create table (?:if not exists )?(?:public\.)?([a-z_]+) ?\((.*)\)$/.exec(st);
      if (create) {
        const set = cols.get(create[1]) ?? new Set<string>();
        for (const term of splitTopLevel(create[2])) {
          const name = /^([a-z_][a-z0-9_]*)\s/.exec(term.trim());
          // Table CONSTRAINTS are not columns.
          if (name && !/^(primary|foreign|unique|check|constraint|exclude)$/.test(name[1])) {
            set.add(name[1]);
          }
        }
        cols.set(create[1], set);
        continue;
      }
      const alter = /^alter table (?:if exists )?(?:only )?(?:public\.)?([a-z_]+) (.*)$/.exec(st);
      if (!alter) continue;
      const set = cols.get(alter[1]);
      if (!set) continue;
      for (const clause of splitTopLevel(alter[2])) {
        const add = /^add column (?:if not exists )?([a-z_][a-z0-9_]*)\s/.exec(clause.trim());
        if (add) set.add(add[1]);
        const ren = /^rename column ([a-z_][a-z0-9_]*) to ([a-z_][a-z0-9_]*)$/.exec(clause.trim());
        if (ren) {
          set.delete(ren[1]);
          set.add(ren[2]);
        }
      }
    }
  }
  return cols;
}

function splitTopLevel(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Top-level terms of a select string, embeds left whole. */
function topLevelTerms(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/**
 * The plain column names a select string asks for.
 *
 * Dropped: `*`, embeds (`x(...)` — their own table's problem), and anything
 * with a `::cast` or a json path. An ALIAS (`alias:column`) contributes the
 * column, never the alias — that distinction is the whole reason a naive
 * split would have missed this defect's neighbours.
 */
export function plainColumns(arg: string): string[] {
  const inner = arg.trim().replace(/^["'`]|["'`]$/g, "");
  if (!inner) return [];
  return topLevelTerms(inner)
    .filter((t) => !/\(/.test(t) && t !== "*")
    .map((t) => (t.includes(":") ? t.slice(t.indexOf(":") + 1) : t))
    .map((t) => t.split("::")[0].split("->")[0].trim())
    .filter((t) => /^[a-z_][a-z0-9_]*$/.test(t));
}

interface Sel {
  file: string;
  table: string;
  arg: string;
}

/**
 * Resolve `.select(COLS)` where COLS is a module-level string const in the
 * same file, including one built by `+`-concatenating literals.
 *
 * Load-bearing rather than a nicety: `send-notification` selects a const, so
 * without this the gate would have skipped the exact query it was written to
 * catch and passed for the wrong reason.
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

/** Every `from("<table>") … .select(<arg>)` in the app AND the edge functions. */
function selects(): Sel[] {
  const found: Sel[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(dir)) {
      const src = readFileSync(file, "utf8");
      const from = /\.from\(\s*"([a-z_]+)"\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = from.exec(src))) {
        const nextFrom = src.indexOf('.from("', m.index + 1);
        const region = src.slice(m.index, nextFrom === -1 ? undefined : nextFrom);
        let sel = firstSelectArg(region);
        if (sel === null) continue;
        // A bare identifier: try to resolve it, and SKIP if we cannot. An
        // unresolvable expression is unknown, not wrong — treating it as a
        // column list is how `payments.cols` got reported as a missing column.
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sel)) {
          const resolved = resolveConst(src, sel);
          if (resolved === null) continue;
          sel = JSON.stringify(resolved);
        } else if (!/^["'`]/.test(sel)) {
          continue;
        }
        found.push({ file, table: m[1], arg: sel });
      }
    }
  }
  return found;
}

describe("every selected column exists", () => {
  it("models the schema from the migrations", () => {
    // A model that knew nothing would permit everything, which is how a guard
    // passes for the wrong reason. Pin the shape of what it learned.
    const cols = tableColumns();
    expect(cols.size).toBeGreaterThan(20);
    expect([...(cols.get("notifications") ?? [])].sort()).toEqual([
      "body", "client_id", "created_at", "email_attempts", "email_claim_token",
      "email_claimed_at", "email_last_error", "email_sent_at", "email_status",
      "id", "operator_id", "push_attempts", "push_claim_token",
      "push_claimed_at", "push_last_error", "push_sent_at", "push_status",
      "read_at", "title", "type", "updated_at", "walk_id",
    ]);
    // The trap this file is named after: the ENUM TYPE 0029 created shares a
    // prefix with the column and is NOT one.
    expect(cols.get("notifications")?.has("email_delivery_status")).toBe(false);
  });

  it("finds selects in the edge functions, not just the app", () => {
    // The defect was in supabase/functions. A scan that only walked app/src
    // would have been green through all of it.
    const edge = selects().filter((s) => s.file.includes("/supabase/functions/"));
    expect(edge.length).toBeGreaterThan(0);
  });

  it("never names a column that does not exist", () => {
    const cols = tableColumns();
    const offenders: string[] = [];
    for (const s of selects()) {
      const known = cols.get(s.table);
      // A table the model never saw is not evidence of a bad column — say
      // nothing rather than fail a healthy build (the M17 lesson: a gate that
      // goes red on a healthy tree is a gate somebody deletes).
      if (!known) continue;
      for (const c of plainColumns(s.arg)) {
        if (!known.has(c)) {
          offenders.push(`${s.file.replace(ROOT + "/", "")}: ${s.table}.${c}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
