import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A supabase-js call whose resolved `error` is discarded is indistinguishable
 * from one that succeeded and found nothing.
 *
 * supabase-js reports PostgREST, GoTrue and transport failures in the RESOLVED
 * `{ data, error }` value and never by rejecting — so `const { data } = await
 * db.from(…)` reads a dead database as an empty table. `fix(edge-errors)`
 * recorded the rule and backlog item 2 recorded the consequence: `getClient`
 * in send-notification turned a transient blip into the TERMINAL skip "client
 * has no email address", permanently cancelling a `payment_failed` email. The
 * rule was written down and connected to nothing; this file is the connection.
 *
 * Parsed, not grepped. The TypeScript compiler API walks every non-test `.ts`
 * under `supabase/functions/`, finds each supabase-js query and classifies
 * the statement that consumes its envelope:
 *
 *   OK            `error` is bound by destructuring, or the envelope is held
 *                 in a variable whose `.error` is read later in the same
 *                 function, or a deferred builder (`let q = db.from(…)`) is
 *                 followed to the statement that awaits it and THAT is OK.
 *   PASSED_ON     the whole envelope is returned or is an arrow function's
 *                 expression body — a caller reads it. Printed, not failed: a
 *                 stated blind spot, the gate does not follow envelopes across
 *                 functions (`unsubscribe/index.ts` hands its envelope to
 *                 `handler.ts`, which reads `result.error`).
 *   DISCARDED     a bare `await <query>;`, or a destructuring that binds
 *                 `data` and not `error`. FAILS.
 *   UNCLASSIFIED  `.then(`, an array literal (`Promise.all([…])`), an
 *                 unrecognised receiver, an unrecognised consumer. FAILS —
 *                 a check that cannot classify must say so rather than pass
 *                 by seeing nothing.
 *
 * What counts as a query, read off the tree rather than recalled: a call
 * `<receiver>.from(` or `<receiver>.rpc(`, or a chain through
 * `<receiver>.auth.<member>` (four exist: `credential-vault` signs in a probe
 * client and lists MFA factors, `claim-signup` creates the user,
 * `_lib/http.ts` resolves the token). The trailing member is load-bearing:
 * `.auth` is GoTrue's NAMESPACE and is never consumed bare, while a bare
 * `keys.auth` (`_lib/webpush.ts`, the push encryption secret) and `sub.auth`
 * (`push_deps.ts`, a subscription row's column) are plain property reads —
 * the first run of this gate called both queries. A namespace handed off
 * whole (`const a = db.auth`) is therefore invisible here, the same blind
 * spot as a builder passed to another function; stated, not chased. No
 * `.storage.` call exists anywhere under `supabase/functions/`, so nothing
 * is built for one. The receiver is the
 * supabase client when it is a lowercase identifier — `db`, which every
 * function either creates with `adminClient()` or takes as a parameter typed
 * `ReturnType<typeof adminClient>` / `SupabaseClient` / a structural
 * `{ rpc() }`, and `probe`, a `createClient(…)` in credential-vault — or a
 * direct `adminClient()` / `createClient(…)` call. A CAPITALISED identifier is
 * a global and is not a query: `Uint8Array.from(binary, …)` in
 * `_lib/crypto.ts` and `Array.from(`. Anything else in receiver position is
 * UNCLASSIFIED, never silently skipped. A lowercase receiver that is not a
 * supabase client would therefore produce a loud, named false red — the
 * reviewable direction — rather than a quiet miss.
 *
 * Reported line: the START of the enclosing statement, in every case. For a
 * deferred builder that is the statement that awaits it, with the builder's
 * own line in the reason.
 */

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * `FUNCTIONS_DIR` is the override `scripts/repo-functions.sh` already honours,
 * and the same one drives this scan, so pointing both at an empty directory
 * exercises the precondition below rather than the real tree.
 */
const FUNCTIONS = process.env.FUNCTIONS_DIR
  ? resolve(process.env.FUNCTIONS_DIR)
  : join(ROOT, "supabase", "functions");

export type Verdict = "OK" | "PASSED_ON" | "DISCARDED" | "UNCLASSIFIED";

export interface Site {
  file: string;
  line: number;
  verdict: Verdict;
  reason: string;
}

/** The deployable functions, by the one predicate the repository keeps. */
function repoFunctions(): string[] {
  const out = execFileSync("bash", [join(ROOT, "scripts", "repo-functions.sh")], {
    cwd: ROOT,
    env: { ...process.env, FUNCTIONS_DIR: FUNCTIONS },
    encoding: "utf8",
  });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Every non-test `.ts` under `dir`; `_tests/` is the deno suite and is skipped. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "_tests" ? [] : sourceFiles(p);
    return /\.ts$/.test(e.name) && !/(\.test|_test|\.d)\.ts$/.test(e.name) ? [p] : [];
  });
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

const QUERY_METHODS = new Set(["from", "rpc"]);
const CLIENT_FACTORIES = new Set(["adminClient", "createClient"]);
/** Consuming a builder through a thenable method is a shape this gate does not read. */
const THENABLE = new Set(["then", "catch", "finally"]);

type ReceiverKind = "client" | "global" | "unknown";

function receiverKind(recv: ts.Expression): ReceiverKind {
  if (ts.isIdentifier(recv)) return /^[A-Z]/.test(recv.text) ? "global" : "client";
  if (ts.isCallExpression(recv) && ts.isIdentifier(recv.expression) && CLIENT_FACTORIES.has(recv.expression.text)) {
    return "client";
  }
  return "unknown";
}

/** The nearest function body (or the file) — where a local variable's uses live. */
function scopeContainer(node: ts.Node): ts.Node {
  let n: ts.Node = node;
  while (!ts.isSourceFile(n) && !ts.isFunctionLike(n)) n = n.parent;
  return n;
}

/** The statement a node sits in — its start line is the line this gate reports. */
function enclosingStatement(node: ts.Node): ts.Node {
  let n: ts.Node = node;
  while (
    n.parent &&
    !ts.isSourceFile(n.parent) &&
    !ts.isBlock(n.parent) &&
    !ts.isCaseClause(n.parent) &&
    !ts.isDefaultClause(n.parent) &&
    !ts.isModuleBlock(n.parent)
  ) {
    n = n.parent;
  }
  return n;
}

/**
 * Walk from a chain's root to its outermost link.
 *
 * `db.from("x").select("y").eq(…).maybeSingle()` is one expression tree with
 * the root call at the bottom; the consumer is whatever holds the top. A
 * `.then(` on the way up ends the walk with a verdict of its own: the value
 * after it is no longer the envelope.
 */
function outermost(node: ts.Node): { top: ts.Node; thenable?: string } {
  let n = node;
  for (;;) {
    const p: ts.Node = n.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === n) {
      if (THENABLE.has(p.name.text)) return { top: p, thenable: p.name.text };
      n = p;
      continue;
    }
    if (ts.isCallExpression(p) && p.expression === n) { n = p; continue; }
    if (
      (ts.isNonNullExpression(p) || ts.isParenthesizedExpression(p) ||
        ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) &&
      p.expression === n
    ) { n = p; continue; }
    // `q = cond ? q.is(…) : q.eq(…)` — both branches are the same builder.
    if (ts.isConditionalExpression(p) && (p.whenTrue === n || p.whenFalse === n)) { n = p; continue; }
    return { top: n };
  }
}

/** Is this identifier a read of a variable (not a declaration, key or write)? */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p)) && p.name === id) return false;
  if (ts.isBinaryExpression(p) && p.left === id && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return false;
  if (ts.isTypeNode(p) || ts.isQualifiedName(p)) return false;
  return true;
}

function usesOf(name: string, container: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === name && isReference(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(container);
  return out;
}

/** Does the destructuring bind `error` (as `error` or `error: alias`)? */
function bindsError(pattern: ts.ObjectBindingPattern): Verdict {
  for (const el of pattern.elements) {
    // `{ data, ...rest }` carries error somewhere the gate cannot see read.
    if (el.dotDotDotToken) return "UNCLASSIFIED";
    const key = el.propertyName ?? el.name;
    if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === "error") return "OK";
  }
  return "DISCARDED";
}

interface Ctx {
  sf: ts.SourceFile;
  file: string;
  /** The query root's line, named in the reason when it differs from the statement's. */
  queryLine: number;
  /** Builder declarations already followed — a cycle is a defect, not an infinite loop. */
  followed: Set<ts.Node>;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function site(ctx: Ctx, at: ts.Node, verdict: Verdict, reason: string): Site {
  const line = lineOf(ctx.sf, enclosingStatement(at));
  const where = line === ctx.queryLine ? "" : ` (query at line ${ctx.queryLine})`;
  return { file: ctx.file, line, verdict, reason: reason + where };
}

/** `const r = await q` or `r = await q`: is `r.error` read later in this function? */
function followEnvelopeVar(ctx: Ctx, nameNode: ts.Identifier, at: ts.Node): Site[] {
  const name = nameNode.text;
  const uses = usesOf(name, scopeContainer(nameNode)).filter((u) => u.pos > nameNode.pos);
  const reads = uses.some((u) => ts.isPropertyAccessExpression(u.parent) && u.parent.expression === u && u.parent.name.text === "error");
  if (reads) return [site(ctx, at, "OK", `envelope in \`${name}\`, \`.error\` read later`)];
  const destructured = uses.some((u) =>
    ts.isVariableDeclaration(u.parent) && u.parent.initializer === u &&
    ts.isObjectBindingPattern(u.parent.name) && bindsError(u.parent.name) === "OK");
  if (destructured) return [site(ctx, at, "OK", `envelope in \`${name}\`, \`error\` destructured later`)];
  const passedOn = uses.some((u) => {
    const p = u.parent;
    return ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === u) || ts.isCallExpression(p) && p.arguments.includes(u);
  });
  if (passedOn) return [site(ctx, at, "PASSED_ON", `envelope in \`${name}\` handed to a caller whole`)];
  return [site(ctx, at, "DISCARDED", `envelope in \`${name}\` whose \`.error\` is never read in this function`)];
}

/** The statement holding `await <chain>`. */
function classifyAwaited(ctx: Ctx, awaited: ts.AwaitExpression): Site[] {
  let n: ts.Node = awaited;
  while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (ts.isVariableDeclaration(p) && p.initializer === n) {
    if (ts.isObjectBindingPattern(p.name)) {
      const v = bindsError(p.name);
      const why = v === "OK" ? "`error` bound"
        : v === "DISCARDED" ? "destructures the envelope without binding `error`"
        : "rest element in the destructuring — cannot see whether `error` is read";
      return [site(ctx, p, v, why)];
    }
    if (ts.isIdentifier(p.name)) return followEnvelopeVar(ctx, p.name, p);
    return [site(ctx, p, "UNCLASSIFIED", "array destructuring of the envelope")];
  }
  if (ts.isExpressionStatement(p)) return [site(ctx, p, "DISCARDED", "bare `await`: the resolved { data, error } is dropped")];
  if (ts.isReturnStatement(p)) return [site(ctx, p, "PASSED_ON", "awaited envelope returned to the caller")];
  if (ts.isArrowFunction(p) && p.body === n) return [site(ctx, p, "PASSED_ON", "awaited envelope is an arrow function's expression body")];
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === n) {
    if (ts.isIdentifier(p.left)) return followEnvelopeVar(ctx, p.left, p);
    if (ts.isObjectLiteralExpression(p.left)) {
      const bound = p.left.properties.some((pr) =>
        (ts.isShorthandPropertyAssignment(pr) && pr.name.text === "error") ||
        (ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name) && pr.name.text === "error"));
      return [site(ctx, p, bound ? "OK" : "DISCARDED", bound ? "`error` assigned" : "destructuring assignment without `error`")];
    }
  }
  return [site(ctx, p, "UNCLASSIFIED", `awaited envelope consumed by ${ts.SyntaxKind[p.kind]}`)];
}

/**
 * `let q = db.from(…)…;` — follow `q` to the statement that consumes it.
 *
 * Reassignments (`q = q.eq(…)`, `q = c ? q.is(…) : q.eq(…)`) continue the
 * builder and classify nothing; an `await`, `return` or arrow body consumes
 * it. A builder nothing consumes is UNCLASSIFIED, not OK.
 */
function followBuilder(ctx: Ctx, nameNode: ts.Identifier, declaration: ts.Node): Site[] {
  if (ctx.followed.has(declaration)) return [];
  ctx.followed.add(declaration);
  const name = nameNode.text;
  const out: Site[] = [];
  for (const use of usesOf(name, scopeContainer(nameNode))) {
    if (use.pos <= nameNode.pos) continue;
    const { top, thenable } = outermost(use);
    if (thenable) { out.push(site(ctx, top, "UNCLASSIFIED", `builder \`${name}\` consumed via .${thenable}()`)); continue; }
    const p = top.parent;
    if (ts.isBinaryExpression(p) && p.right === top && ts.isIdentifier(p.left) && p.left.text === name) continue;
    out.push(...classifyTop(ctx, top, `builder \`${name}\` (line ${lineOf(ctx.sf, declaration)}) `));
  }
  if (out.length === 0) {
    out.push(site(ctx, declaration, "UNCLASSIFIED", `builder \`${name}\` is never awaited, returned or passed on in this function`));
  }
  return out;
}

/** Classify by what holds the top of the chain. `prefix` names a followed builder. */
function classifyTop(ctx: Ctx, top: ts.Node, prefix = ""): Site[] {
  const p = top.parent;
  const tag = (s: Site): Site => ({ ...s, reason: prefix + s.reason });
  if (ts.isAwaitExpression(p)) return classifyAwaited(ctx, p).map(tag);
  if (ts.isReturnStatement(p)) return [tag(site(ctx, p, "PASSED_ON", "envelope promise returned to the caller"))];
  if (ts.isArrowFunction(p) && p.body === top) return [tag(site(ctx, p, "PASSED_ON", "envelope promise is an arrow function's expression body"))];
  if (ts.isVariableDeclaration(p) && p.initializer === top && ts.isIdentifier(p.name)) return followBuilder(ctx, p.name, p).map(tag);
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === top && ts.isIdentifier(p.left)) {
    return followBuilder(ctx, p.left, p).map(tag);
  }
  return [tag(site(ctx, p, "UNCLASSIFIED", `query consumed by ${ts.SyntaxKind[p.kind]}`))];
}

/** Every supabase-js query in `text`, classified. `file` is only for reporting. */
export function classifySource(text: string, file: string): Site[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: Site[] = [];
  const followed = new Set<ts.Node>();

  const seen = (root: ts.Node, recv: ts.Expression, token: ts.Node) => {
    const ctx: Ctx = { sf, file, queryLine: lineOf(sf, token), followed };
    const kind = receiverKind(recv);
    if (kind === "global") return;
    if (kind === "unknown") {
      sites.push(site(ctx, root, "UNCLASSIFIED", `unrecognised receiver \`${recv.getText(sf)}\``));
      return;
    }
    const { top, thenable } = outermost(root);
    if (thenable) { sites.push(site(ctx, top, "UNCLASSIFIED", `query consumed via .${thenable}()`)); return; }
    sites.push(...classifyTop(ctx, top));
  };

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && QUERY_METHODS.has(n.expression.name.text)) {
      seen(n, n.expression.expression, n.expression.name);
    } else if (
      ts.isPropertyAccessExpression(n) && n.name.text === "auth" &&
      // The namespace, `.auth.<member>` — a bare `.auth` is a value being read.
      ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n
    ) {
      seen(n, n.expression, n.name);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

function scan(): { files: string[]; sites: Site[] } {
  const files = sourceFiles(FUNCTIONS);
  const sites = files.flatMap((f) => classifySource(readFileSync(f, "utf8"), relative(ROOT, f)));
  return { files, sites };
}

const fmt = (s: Site) => `${s.file}:${s.line} — ${s.reason}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classifySource", () => {
  const one = (src: string) => {
    const sites = classifySource(src, "fixture.ts");
    expect(sites, `expected exactly one site in:\n${src}`).toHaveLength(1);
    return sites[0];
  };

  it("OK: error bound by destructuring", () => {
    const s = one(`async function f(db: any, id: string) {
  const { data, error } = await db.from("clients").select("id").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}`);
    expect(s.verdict).toBe("OK");
    expect(s.line).toBe(2);
  });

  it("OK: aliased binding `error: e`", () => {
    expect(one(`async function f(db: any) {
  const { data: rows, error: e } = await db.rpc("fn_x", {});
  if (e) throw e;
  return rows;
}`).verdict).toBe("OK");
  });

  it("OK: deferred builder followed to the statement that awaits it", () => {
    const s = one(`async function f(db: any, op: string | null) {
  let q = db.from("notifications").select("id").eq("id", "x");
  if (op) q = q.eq("operator_id", op);
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data;
}`);
    expect(s.verdict).toBe("OK");
    expect(s.line).toBe(4);
    expect(s.reason).toMatch(/builder `q` \(line 2\)/);
  });

  it("OK: envelope variable whose .error is read later", () => {
    expect(one(`async function f(db: any) {
  const r = await db.from("walks").update({ a: 1 }).eq("id", "x");
  if (r.error) throw r.error;
}`).verdict).toBe("OK");
  });

  it("DISCARDED: bare await", () => {
    const s = one(`async function f(db: any) {
  await db.from("clients").update({ a: 1 }).eq("id", "x");
}`);
    expect(s.verdict).toBe("DISCARDED");
    expect(s.reason).toMatch(/bare `await`/);
  });

  it("DISCARDED: destructuring { data } only", () => {
    const s = one(`async function f(db: any) {
  const { data } = await db
    .from("clients")
    .select("email")
    .maybeSingle();
  return data;
}`);
    expect(s.verdict).toBe("DISCARDED");
    expect(s.line).toBe(2);
    expect(s.reason).toMatch(/without binding `error`/);
    expect(s.reason).toMatch(/query at line 3/);
  });

  it("DISCARDED: envelope variable never read for .error", () => {
    expect(one(`async function f(db: any) {
  const r = await db.rpc("fn_x", {});
  console.log(r.data);
}`).verdict).toBe("DISCARDED");
  });

  it("UNCLASSIFIED: consumed via .then()", () => {
    const s = one(`function f(db: any) {
  db.from("clients").select("id").then((r: any) => r.data);
}`);
    expect(s.verdict).toBe("UNCLASSIFIED");
    expect(s.reason).toMatch(/\.then\(\)/);
  });

  it("UNCLASSIFIED: inside Promise.all", () => {
    expect(one(`async function f(db: any) {
  const [a] = await Promise.all([db.from("clients").select("id")]);
  return a;
}`).verdict).toBe("UNCLASSIFIED");
  });

  it("UNCLASSIFIED: a builder nothing consumes", () => {
    expect(one(`function f(db: any) {
  const q = db.from("clients").select("id");
  q.eq("id", "x");
}`).verdict).toBe("UNCLASSIFIED");
  });

  it("PASSED_ON: envelope returned / arrow expression body", () => {
    const sites = classifySource(`const suppress = async (t: string) => await adminClient().rpc("fn_x", { p: t });
function g(db: any) { return db.from("clients").select("id"); }`, "fixture.ts");
    expect(sites.map((s) => s.verdict)).toEqual(["PASSED_ON", "PASSED_ON"]);
  });

  it("receivers: a capitalised global is not a query; anything unrecognised is UNCLASSIFIED", () => {
    expect(classifySource(`const b = Uint8Array.from("ab", (c) => c.charCodeAt(0)); const a = Array.from([1]);`, "f.ts")).toEqual([]);
    const s = one(`async function f(deps: any) { const { data, error } = await deps.db.from("x").select("id"); if (error) throw error; return data; }`);
    expect(s.verdict).toBe("UNCLASSIFIED");
    expect(s.reason).toMatch(/unrecognised receiver `deps\.db`/);
  });

  it("auth calls are queries too; a bare `.auth` property read is not", () => {
    const sites = classifySource(`async function f(db: any, probe: any) {
  const { error } = await probe.auth.signInWithPassword({ email: "a", password: "b" });
  if (error) return false;
  await db.auth.admin.createUser({ email: "a" });
}`, "f.ts");
    expect(sites.map((s) => s.verdict)).toEqual(["OK", "DISCARDED"]);
    // The two shapes the first run of this gate mistook for GoTrue calls.
    expect(classifySource(`function g(keys: { auth: string }, sub: { auth: string }) {
  const secret = decode(keys.auth);
  return { p256dh: "x", auth: sub.auth, secret };
}`, "f.ts")).toEqual([]);
  });
});

describe("supabase-js envelopes in supabase/functions", () => {
  it("scans every deployable function directory and _lib", () => {
    // A classifier that sees nothing must fail here, not pass below.
    const functions = repoFunctions();
    expect(functions.length, `scripts/repo-functions.sh found no function directory under ${FUNCTIONS}`).toBeGreaterThan(0);
    const { files } = scan();
    const rel = files.map((f) => relative(FUNCTIONS, f));
    const unscanned = [...functions, "_lib"].filter((d) => !rel.some((f) => f.startsWith(d + "/")));
    expect(unscanned, "function directories with no scanned source file").toEqual([]);
  });

  it("classifies the known-good deferred builder in send-notification/deps.ts as OK", () => {
    // `getNotification` is `let q = db.from("notifications")…; … await
    // q.maybeSingle()` with `error` bound — the shape a classifier that
    // cannot follow a builder would call UNCLASSIFIED, and one that cannot
    // see queries at all would never report. Either failure lands here.
    const ok = scan().sites.filter((s) =>
      s.file.endsWith("send-notification/deps.ts") && s.verdict === "OK" && /builder `q`/.test(s.reason));
    expect(ok.map(fmt), "no OK deferred-builder site found in send-notification/deps.ts").not.toEqual([]);
  });

  it("never discards a supabase-js error", () => {
    const { sites } = scan();
    const passedOn = sites.filter((s) => s.verdict === "PASSED_ON");
    if (passedOn.length > 0) {
      console.info(["envelopes passed on whole (not followed across functions):", ...passedOn.map(fmt)].join("\n  "));
    }
    const offenders = sites.filter((s) => s.verdict === "DISCARDED" || s.verdict === "UNCLASSIFIED").map((s) => `${s.verdict} ${fmt(s)}`);
    expect(offenders, ["supabase-js queries whose resolved `error` is discarded or could not be classified:", ...offenders].join("\n  ")).toEqual([]);
  });
});
