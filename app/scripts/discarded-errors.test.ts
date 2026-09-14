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
 * Parsed, not grepped — and RESOLVED, not name-matched: every identifier
 * goes through the TypeScript checker's symbol, so a same-named variable in
 * a nested block, callback, loop or catch clause is a different binding by
 * construction. The compiler API walks every non-test `.ts` under
 * `supabase/functions/`, finds each supabase-js query and classifies the
 * statement that consumes its envelope:
 *
 *   OK            `error` is bound by destructuring AND referenced later in
 *                 the same function, or the envelope is held in a variable
 *                 whose `.error` is read later — before the binding is
 *                 overwritten (by assignment, plain or through a pattern,
 *                 a `var` re-declaration or a `var` loop variable) and
 *                 before `.error` itself is written through any alias of
 *                 the same object — or `.error` is read straight off the
 *                 awaited expression, or a deferred builder (`let q =
 *                 db.from(…)`) is followed to the statement that awaits it
 *                 and THAT is OK, or the chain ends in `.throwOnError()`,
 *                 which throws instead of resolving an error.
 *   PASSED_ON     the whole envelope is returned, or is the expression body
 *                 of an arrow that is NOT a call's argument (a deps-object
 *                 property, say) — a caller reads it. Printed, not failed: a
 *                 stated blind spot, the gate does not follow envelopes across
 *                 functions (`unsubscribe/index.ts` hands its envelope to
 *                 `handler.ts`, which reads `result.error`).
 *   DISCARDED     a bare `await <query>;`, a destructuring that binds `data`
 *                 and not `error`, or one that binds `error` and never reads
 *                 it. FAILS.
 *   UNCLASSIFIED  `.then(`, an array literal (`Promise.all([…])`), an arrow
 *                 body that is an inline callback (`ids.map((id) =>
 *                 db.from(…))` — the array nothing reads), an envelope
 *                 variable passed to a call (`console.log(r)`), an
 *                 unrecognised receiver, an unrecognised consumer. FAILS —
 *                 a check that cannot classify must say so rather than pass
 *                 by seeing nothing.
 *
 * What counts as a query, read off the tree rather than recalled: a call
 * `<receiver>.from(` or `<receiver>.rpc(` (spelled `db["from"](…)` too), or
 * a chain through `<receiver>.auth.<member>` (four exist: `credential-vault`
 * signs in a probe client and lists MFA factors, `claim-signup` creates the
 * user, `_lib/http.ts` resolves the token). `auth` is ALSO a plain field
 * name in this tree — `keys.auth` (`_lib/webpush.ts`, the push encryption
 * secret) and `sub.auth` (`push_deps.ts`, a subscription row's column) — so
 * for `.auth` the word is not enough and the RECEIVER decides, by the
 * declaration its SYMBOL resolves to: `adminClient()` / `createClient(…)`
 * called inline, a variable initialised from one (at declaration or by a
 * later assignment), or a parameter or variable typed as one, one type
 * alias deep. A receiver declared as anything else is a value and
 * `sub.auth.length` is a healthy read; a receiver whose declaration the
 * gate cannot read — an import, a class member, a destructured parameter,
 * a call that is not a known factory — is UNCLASSIFIED: loud, never
 * skipped. A namespace
 * handed off whole (`const a = db.auth`) is therefore invisible here, the
 * same blind spot as a builder passed to another function; stated, not
 * chased. No `.storage.` call exists anywhere under `supabase/functions/`,
 * so nothing is built for one. For `.from` / `.rpc` the receiver is the
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
//
// Identifiers are resolved through the TypeScript CHECKER's symbols, never by
// name. Four review rounds on PR #92 each found one more way a name-based
// model attributed a same-named variable to the wrong binding — a callback
// parameter, a block-local `const`, a `for (var r …)` loop variable, an
// earlier declaration in a nested block — and every fix closed an instance
// rather than the class. A symbol IS the binding, so shadows, block scope,
// `var` hoisting and parameters fall out of the binder instead of out of a
// list of syntactic forms. Imports are not resolved (`noResolve`), which is
// all a per-file scan needs: a local's symbol never crosses a file.

const QUERY_METHODS = new Set(["from", "rpc"]);
const CLIENT_FACTORIES = new Set(["adminClient", "createClient"]);
/** Consuming a builder through a thenable method is a shape this gate does not read. */
const THENABLE = new Set(["then", "catch", "finally"]);
/** A chain ending here THROWS on failure; there is no envelope to discard. */
const THROWING_TERMINALS = new Set(["throwOnError"]);

const COMPILER_OPTIONS: ts.CompilerOptions = {
  noLib: true,
  noResolve: true,
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  types: [],
};

/** A program over in-memory sources, so fixtures and the real tree go through one path. */
function programOver(files: Map<string, string>): ts.Program {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      const text = files.get(name);
      return text === undefined ? undefined : ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => files.has(f),
    readFile: (f) => files.get(f),
    directoryExists: () => true,
    getDirectories: () => [],
  };
  return ts.createProgram([...files.keys()], COMPILER_OPTIONS, host);
}

type ReceiverKind = "client" | "global" | "unknown";

function receiverKind(recv: ts.Expression): ReceiverKind {
  if (ts.isIdentifier(recv)) return /^[A-Z]/.test(recv.text) ? "global" : "client";
  if (ts.isCallExpression(recv) && ts.isIdentifier(recv.expression) && CLIENT_FACTORIES.has(recv.expression.text)) {
    return "client";
  }
  return "unknown";
}

/** The nearest function body (or the file) — where a local's uses can live. */
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

/** Transparent wrappers around an expression: `(e)`, `e as T`, `e!`, `e satisfies T`. */
function isTransparent(p: ts.Node, child: ts.Node): boolean {
  return (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) ||
    ts.isSatisfiesExpression(p)) && p.expression === child;
}

/**
 * Walk from a chain's root to its outermost link.
 *
 * `db.from("x").select("y").eq(…).maybeSingle()` is one expression tree with
 * the root call at the bottom; the consumer is whatever holds the top. A
 * `.then(` on the way up ends the walk with a verdict of its own: the value
 * after it is no longer the envelope. A `.throwOnError()` ends it too — the
 * builder throws instead of resolving an error, so there is nothing to bind.
 */
function outermost(node: ts.Node): { top: ts.Node; thenable?: string; throws?: boolean } {
  let n = node;
  let throws = false;
  for (;;) {
    const p: ts.Node = n.parent;
    const m = memberAccess(p);
    if (m && m.receiver === n) {
      if (THENABLE.has(m.name)) return { top: p, thenable: m.name };
      if (THROWING_TERMINALS.has(m.name)) throws = true;
      n = p;
      continue;
    }
    if (ts.isCallExpression(p) && p.expression === n) { n = p; continue; }
    if (isTransparent(p, n)) { n = p; continue; }
    // `q = cond ? q.is(…) : q.eq(…)` — both branches are the same builder.
    if (ts.isConditionalExpression(p) && (p.whenTrue === n || p.whenFalse === n)) { n = p; continue; }
    return { top: n, throws };
  }
}

/** `=` and every compound assignment (`??=`, `+=`, …) — all of them overwrite. */
function isAssignmentKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** `let` or `const` (block-scoped), as opposed to `var` (function-scoped). */
function isBlockScoped(list: ts.VariableDeclarationList): boolean {
  return (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
}

/** Is this arrow function an argument of a call — a callback whose consumer the gate cannot see? */
function inlineCallback(fn: ts.ArrowFunction): boolean {
  return ts.isCallExpression(fn.parent) && fn.parent.arguments.includes(fn);
}

/**
 * `<receiver>.<name>` spelled either way — `db.from(…)` or `db["from"](…)`,
 * `r.error` or `r["error"]`; the element-access spelling is the same member
 * and must not be invisible to the scan (adversarial review and Codex on
 * PR #92).
 */
function memberAccess(n: ts.Node | undefined): { receiver: ts.Expression; name: string; token: ts.Node } | null {
  if (!n) return null;
  if (ts.isPropertyAccessExpression(n)) return { receiver: n.expression, name: n.name.text, token: n.name };
  if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression)) {
    return { receiver: n.expression, name: n.argumentExpression.text, token: n.argumentExpression };
  }
  return null;
}

/**
 * Every identifier an assignment TARGET writes: the plain `r = …`, and the
 * pattern forms `({ r } = …)`, `({ x: r } = …)`, `[r] = …`, `[...r] = …`
 * (Codex on PR #92: a destructuring assignment is a write like any other).
 */
function assignmentTargets(target: ts.Expression): ts.Identifier[] {
  if (ts.isIdentifier(target)) return [target];
  if (isTransparent(target, (target as ts.ParenthesizedExpression).expression ?? target) && "expression" in target) {
    return assignmentTargets((target as ts.ParenthesizedExpression).expression);
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((pr) => {
      if (ts.isShorthandPropertyAssignment(pr)) return [pr.name];
      if (ts.isPropertyAssignment(pr)) return assignmentTargets(pr.initializer);
      if (ts.isSpreadAssignment(pr)) return assignmentTargets(pr.expression);
      return [];
    });
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((el) =>
      ts.isSpreadElement(el) ? assignmentTargets(el.expression) : ts.isOmittedExpression(el) ? [] : assignmentTargets(el));
  }
  return [];
}

/** The symbol an identifier resolves to — its BINDING, whatever its name. */
function symbolOf(checker: ts.TypeChecker, id: ts.Identifier): ts.Symbol | undefined {
  // `{ r }` in an object literal (a read, or a destructuring-assignment
  // target) names the PROPERTY at the identifier; the value's symbol is the
  // variable and is what the gate follows.
  if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(id.parent) ?? checker.getSymbolAtLocation(id);
  }
  return checker.getSymbolAtLocation(id);
}

/** The identifier that DECLARES a binding — a variable's name, a parameter's, a binding element's. */
function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  return ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === id) ||
    (ts.isBindingElement(p) && p.propertyName === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) && p.name === id) ||
    (memberAccess(p)?.token === id);
}

/**
 * Every place the binding `sym` is WRITTEN inside `container`, as
 * positions: assignments to it (any operator, plain or through a pattern),
 * a `var` re-declaration with an initialiser (`{ var r = other; }` is the
 * same function-scoped binding, re-assigned), a `var` loop variable
 * (`for (var r of rows)`) and a bare loop target (`for (r of rows)`).
 */
function writesTo(checker: ts.TypeChecker, sym: ts.Symbol, container: ts.Node): number[] {
  const out: number[] = [];
  const target = (t: ts.Expression) => {
    for (const id of assignmentTargets(t)) if (symbolOf(checker, id) === sym) out.push(id.pos);
  };
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && isAssignmentKind(n.operatorToken.kind)) target(n.left);
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isVariableDeclarationList(n.parent) && !isBlockScoped(n.parent) &&
      ts.isIdentifier(n.name) && symbolOf(checker, n.name) === sym) out.push(n.name.pos);
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      const init = n.initializer;
      if (ts.isVariableDeclarationList(init)) {
        if (!isBlockScoped(init)) {
          for (const d of init.declarations) if (ts.isIdentifier(d.name) && symbolOf(checker, d.name) === sym) out.push(d.name.pos);
        }
      } else target(init);
    }
    ts.forEachChild(n, visit);
  };
  visit(container);
  return out;
}

/** The first write to `sym` after `after`, or Infinity. */
function nextWriteTo(checker: ts.TypeChecker, sym: ts.Symbol, container: ts.Node, after: number): number {
  return Math.min(Infinity, ...writesTo(checker, sym, container).filter((w) => w > after));
}

/**
 * Every READ of the binding `sym` inside `container`: identifiers that
 * resolve to it and are neither its declaration nor a write target. A
 * shadow has a different symbol and is never counted (the whole point).
 */
function usesOf(checker: ts.TypeChecker, sym: ts.Symbol, container: ts.Node): ts.Identifier[] {
  const written = new Set<number>(writesTo(checker, sym, container));
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && !isDeclarationName(n) && !written.has(n.pos) && symbolOf(checker, n) === sym) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(container);
  return out;
}

/** `r.error` / `r["error"]` on this identifier, or null. */
function errorAccess(u: ts.Identifier): ts.Expression | null {
  const m = memberAccess(u.parent);
  return m && m.receiver === u && m.name === "error" ? (u.parent as ts.Expression) : null;
}

/** Is this `.error` access being WRITTEN (`r.error = null`, `r.error ??= x`, `delete r.error`) rather than read? */
function isErrorWrite(access: ts.Expression): boolean {
  const p = access.parent;
  return (ts.isBinaryExpression(p) && p.left === access && isAssignmentKind(p.operatorToken.kind)) ||
    ts.isDeleteExpression(p);
}

/**
 * Does the destructuring bind `error` (as `error` or `error: alias`) AND is
 * the local it binds read afterwards?
 *
 * Presence in the binding pattern is not enough (Codex review on PR #92):
 * `const { data, error } = await q; return data;` names the error and then
 * treats the envelope as ordinary data, which is the defect this gate exists
 * to catch wearing the fix's clothes. So the bound identifier — the alias,
 * when there is one — must be referenced later, before it is overwritten. A
 * nested pattern (`error: { code }`) is a read by construction.
 */
function bindsError(ctx: Ctx, pattern: ts.ObjectBindingPattern): { verdict: Verdict; local?: string } {
  for (const el of pattern.elements) {
    // `{ data, ...rest }` carries error somewhere the gate cannot see read.
    if (el.dotDotDotToken) return { verdict: "UNCLASSIFIED" };
    const key = el.propertyName ?? el.name;
    if (!((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === "error")) continue;
    if (!ts.isIdentifier(el.name)) return { verdict: "OK" };
    return isReadAfter(ctx, el.name)
      ? { verdict: "OK" }
      : { verdict: "DISCARDED", local: el.name.text };
  }
  return { verdict: "DISCARDED" };
}

/** Is this bound identifier read after its binding and before it is overwritten? */
function isReadAfter(ctx: Ctx, bound: ts.Identifier): boolean {
  // Before the local is overwritten: `let { error } = await q; error = null;
  // if (error) …` reads the null, not the query's error (Codex on PR #92).
  const sym = symbolOf(ctx.checker, bound);
  if (!sym) return false;
  const container = scopeContainer(bound);
  const overwritten = nextWriteTo(ctx.checker, sym, container, bound.pos);
  return usesOf(ctx.checker, sym, container).some((u) => u.pos > bound.pos && u.pos < overwritten);
}

interface Ctx {
  sf: ts.SourceFile;
  checker: ts.TypeChecker;
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
  const container = scopeContainer(nameNode);

  // The envelope GROUP: the binding, plus every alias (`const copy = r`)
  // reached from it, transitively. All of them name ONE object, so a write
  // to `.error` through any member closes the window for every member
  // (Codex on PR #92: `const copy = r; r.error = null; if (copy.error) …`
  // reads the null). Each member's own window still ends where THAT binding
  // is overwritten (`let r = await a; r = await b`).
  interface Member { id: ts.Identifier; uses: ts.Identifier[] }
  const members: Member[] = [];
  const queue: ts.Identifier[] = [nameNode];
  const seenSym = new Set<ts.Symbol>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    const sym = symbolOf(ctx.checker, id);
    if (!sym || seenSym.has(sym)) continue;
    seenSym.add(sym);
    const overwritten = nextWriteTo(ctx.checker, sym, container, id.pos);
    const uses = usesOf(ctx.checker, sym, container).filter((u) => u.pos > id.pos && u.pos < overwritten);
    members.push({ id, uses });
    for (const u of uses) {
      const d = u.parent;
      if (ts.isVariableDeclaration(d) && d.initializer === u && ts.isIdentifier(d.name)) queue.push(d.name);
    }
  }
  const allUses = members.flatMap((m) => m.uses);
  const errorWrittenAt = Math.min(...allUses.map((u) => { const a = errorAccess(u); return a && isErrorWrite(a) ? u.pos : Infinity; }));
  const uses = allUses.filter((u) => u.pos < errorWrittenAt);
  const via = (u: ts.Identifier) => u.text === name ? "" : ` (through alias \`${u.text}\`)`;

  const read = uses.find((u) => { const a = errorAccess(u); return a !== null && !isErrorWrite(a); });
  if (read) return [site(ctx, at, "OK", `envelope in \`${name}\`, \`.error\` read later${via(read)}`)];
  const destructured = uses.find((u) =>
    ts.isVariableDeclaration(u.parent) && u.parent.initializer === u &&
    ts.isObjectBindingPattern(u.parent.name) && bindsError(ctx, u.parent.name).verdict === "OK");
  if (destructured) return [site(ctx, at, "OK", `envelope in \`${name}\`, \`error\` destructured later${via(destructured)}`)];
  const passedOn = uses.find((u) => {
    const p = u.parent;
    return ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === u && !inlineCallback(p));
  });
  if (passedOn) return [site(ctx, at, "PASSED_ON", `envelope in \`${name}\` handed to a caller whole${via(passedOn)}`)];
  // `console.log(r)` / `JSON.stringify(r)` / `helper(r)`: the gate cannot see
  // what the callee does with it, and a debug print beside `return r.data`
  // must not turn a discard into a pass (adversarial review on PR #92).
  const passedToCall = uses.find((u) => ts.isCallExpression(u.parent) && u.parent.arguments.includes(u));
  if (passedToCall) {
    return [site(ctx, at, "UNCLASSIFIED", `envelope in \`${name}\` passed to a call — its consumer is not visible${via(passedToCall)}`)];
  }
  return [site(ctx, at, "DISCARDED", `envelope in \`${name}\` whose \`.error\` is never read in this function`)];
}

/** The statement holding `await <chain>`. */
function classifyAwaited(ctx: Ctx, awaited: ts.AwaitExpression): Site[] {
  let n: ts.Node = awaited;
  // `(await q)`, `(await q) as T`, `(await q)!` — wrappers that change
  // nothing about the envelope (adversarial review on PR #92).
  while (isTransparent(n.parent, n)) n = n.parent;
  const p = n.parent;
  // `(await q).error` read straight off the expression.
  const direct = memberAccess(p);
  if (direct && direct.receiver === n && direct.name === "error") {
    return isErrorWrite(p as ts.Expression)
      ? [site(ctx, p, "DISCARDED", "`.error` written on the awaited envelope, never read")]
      : [site(ctx, p, "OK", "`.error` read directly off the awaited envelope")];
  }
  if (ts.isVariableDeclaration(p) && p.initializer === n) {
    if (ts.isObjectBindingPattern(p.name)) {
      const { verdict: v, local } = bindsError(ctx, p.name);
      const why = v === "OK" ? "`error` bound and read"
        : v === "DISCARDED" && local ? `\`error\` bound as \`${local}\` and never read in this function`
        : v === "DISCARDED" ? "destructures the envelope without binding `error`"
        : "rest element in the destructuring — cannot see whether `error` is read";
      return [site(ctx, p, v, why)];
    }
    if (ts.isIdentifier(p.name)) return followEnvelopeVar(ctx, p.name, p);
    return [site(ctx, p, "UNCLASSIFIED", "array destructuring of the envelope")];
  }
  if (ts.isExpressionStatement(p)) return [site(ctx, p, "DISCARDED", "bare `await`: the resolved { data, error } is dropped")];
  if (ts.isReturnStatement(p)) return [site(ctx, p, "PASSED_ON", "awaited envelope returned to the caller")];
  if (ts.isArrowFunction(p) && p.body === n) {
    // `ids.map(async (id) => await db.from(…)…)` inside a `Promise.all`: the
    // envelopes land in an array nothing reads. An arrow that is a call's
    // argument has no visible consumer (adversarial review on PR #92).
    return inlineCallback(p)
      ? [site(ctx, p, "UNCLASSIFIED", "awaited envelope is the body of an inline callback — its consumer is not visible")]
      : [site(ctx, p, "PASSED_ON", "awaited envelope is an arrow function's expression body")];
  }
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === n) {
    if (ts.isIdentifier(p.left)) return followEnvelopeVar(ctx, p.left, p);
    if (ts.isObjectLiteralExpression(p.left)) {
      // `({ error } = await q)` / `({ error: e } = await q)`: the target is the
      // shorthand name itself, or the property's initializer.
      const target = p.left.properties.map((pr) =>
        ts.isShorthandPropertyAssignment(pr) && pr.name.text === "error" ? pr.name
        : ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name) && pr.name.text === "error" && ts.isIdentifier(pr.initializer) ? pr.initializer
        : null).find((t) => t !== null);
      if (!target) return [site(ctx, p, "DISCARDED", "destructuring assignment without `error`")];
      return isReadAfter(ctx, target)
        ? [site(ctx, p, "OK", "`error` assigned and read")]
        : [site(ctx, p, "DISCARDED", `\`error\` assigned to \`${target.text}\` and never read in this function`)];
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
  const sym = symbolOf(ctx.checker, nameNode);
  const out: Site[] = [];
  if (sym) {
    const container = scopeContainer(nameNode);
    // A builder is re-assigned to itself as it grows, so its writes are its
    // uses here: look at every reference, reads and writes alike.
    const refs: ts.Identifier[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && !isDeclarationName(n) && symbolOf(ctx.checker, n) === sym) refs.push(n);
      ts.forEachChild(n, visit);
    };
    visit(container);
    for (const use of refs) {
      if (use.pos <= nameNode.pos) continue;
      const { top, thenable, throws } = outermost(use);
      if (thenable) { out.push(site(ctx, top, "UNCLASSIFIED", `builder \`${name}\` consumed via .${thenable}()`)); continue; }
      const p = top.parent;
      if (ts.isBinaryExpression(p) && p.right === top && ts.isIdentifier(p.left) && symbolOf(ctx.checker, p.left) === sym) continue;
      if (ts.isBinaryExpression(p) && p.left === top && isAssignmentKind(p.operatorToken.kind)) continue;
      if (throws) { out.push(site(ctx, top, "OK", `builder \`${name}\` ends in .throwOnError() — a failure throws, no envelope to discard`)); continue; }
      out.push(...classifyTop(ctx, top, `builder \`${name}\` (line ${lineOf(ctx.sf, declaration)}) `));
    }
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
  if (ts.isArrowFunction(p) && p.body === top) {
    return inlineCallback(p)
      ? [tag(site(ctx, p, "UNCLASSIFIED", "envelope promise is the body of an inline callback — its consumer is not visible"))]
      : [tag(site(ctx, p, "PASSED_ON", "envelope promise is an arrow function's expression body"))];
  }
  if (ts.isVariableDeclaration(p) && p.initializer === top && ts.isIdentifier(p.name)) return followBuilder(ctx, p.name, p).map(tag);
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === top && ts.isIdentifier(p.left)) {
    return followBuilder(ctx, p.left, p).map(tag);
  }
  return [tag(site(ctx, p, "UNCLASSIFIED", `query consumed by ${ts.SyntaxKind[p.kind]}`))];
}

type Declared = "client" | "value" | "unknown";

/** A type annotation's text, one alias deep: `type Db = ReturnType<typeof adminClient>` counts. */
function typeText(checker: ts.TypeChecker, t: ts.TypeNode | undefined): string {
  if (!t) return "";
  if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
    const sym = checker.getSymbolAtLocation(t.typeName);
    const alias = sym?.declarations?.find(ts.isTypeAliasDeclaration);
    if (alias) return alias.type.getText();
  }
  return t.getText();
}

const CLIENT_TYPE = /SupabaseClient|adminClient|createClient/;

/**
 * Is this receiver a supabase client, by how its BINDING is declared? The
 * checker resolves the identifier to its symbol, so an earlier same-named
 * declaration in a nested block is not consulted (Codex on PR #92). A
 * factory call, a variable initialised from one (at declaration, or by a
 * later `db = adminClient()`), or a parameter or variable typed as one — one
 * alias deep — is a client; anything else declared in the file is a value;
 * a receiver with no declaration the checker can see is unknown.
 */
function declaredAsClient(ctx: Ctx, recv: ts.Expression): Declared {
  if (ts.isCallExpression(recv) && ts.isIdentifier(recv.expression) && CLIENT_FACTORIES.has(recv.expression.text)) {
    return "client";
  }
  if (!ts.isIdentifier(recv)) return "unknown";
  const sym = symbolOf(ctx.checker, recv);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (!decl) return "unknown";
  const isFactory = (e: ts.Expression | undefined): boolean =>
    !!e && ((ts.isCallExpression(e) && ts.isIdentifier(e.expression) && CLIENT_FACTORIES.has(e.expression.text)) ||
      (ts.isAwaitExpression(e) && isFactory(e.expression)));
  if (ts.isVariableDeclaration(decl)) {
    if (isFactory(decl.initializer)) return "client";
    if (CLIENT_TYPE.test(typeText(ctx.checker, decl.type))) return "client";
    // `let db; … db = adminClient();`
    let assignedFactory = false;
    const visit = (n: ts.Node) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) &&
        symbolOf(ctx.checker, n.left) === sym && isFactory(n.right)) assignedFactory = true;
      ts.forEachChild(n, visit);
    };
    visit(ctx.sf);
    return assignedFactory ? "client" : "value";
  }
  if (ts.isParameter(decl)) return CLIENT_TYPE.test(typeText(ctx.checker, decl.type)) ? "client" : "value";
  if (ts.isBindingElement(decl)) {
    // `({ db }: Deps)` — the client is somewhere inside a type the gate
    // cannot read; refuse loudly rather than guess either way.
    let p: ts.Node = decl;
    while (ts.isBindingElement(p) || ts.isObjectBindingPattern(p) || ts.isArrayBindingPattern(p)) p = p.parent;
    const t = ts.isParameter(p) || ts.isVariableDeclaration(p) ? p.type : undefined;
    return CLIENT_TYPE.test(typeText(ctx.checker, t)) ? "client" : "unknown";
  }
  // An import, a class member, a function — nothing this gate can read.
  return "unknown";
}

/** Classify every supabase-js query in one source file of `program`. */
function classifyFile(program: ts.Program, sf: ts.SourceFile, file: string): Site[] {
  const checker = program.getTypeChecker();
  const sites: Site[] = [];
  const followed = new Set<ts.Node>();

  const seen = (root: ts.Node, recv: ts.Expression, token: ts.Node) => {
    const ctx: Ctx = { sf, checker, file, queryLine: lineOf(sf, token), followed };
    const kind = receiverKind(recv);
    if (kind === "global") return;
    if (kind === "unknown") {
      sites.push(site(ctx, root, "UNCLASSIFIED", `unrecognised receiver \`${recv.getText(sf)}\``));
      return;
    }
    const { top, thenable, throws } = outermost(root);
    if (thenable) { sites.push(site(ctx, top, "UNCLASSIFIED", `query consumed via .${thenable}()`)); return; }
    if (throws) { sites.push(site(ctx, top, "OK", "chain ends in .throwOnError() — a failure throws, no envelope to discard")); return; }
    sites.push(...classifyTop(ctx, top));
  };

  const visit = (n: ts.Node) => {
    const member = ts.isCallExpression(n) ? memberAccess(n.expression) : null;
    if (member && QUERY_METHODS.has(member.name)) {
      seen(n, member.receiver, member.token);
    } else {
      const auth = memberAccess(n);
      if (
        auth && auth.name === "auth" &&
        // The namespace, `.auth.<member>` — a bare `.auth` is a value being read.
        memberAccess(n.parent)?.receiver === n
      ) {
        // `auth` is also a plain FIELD in this tree (the push encryption
        // secret), and `sub.auth.length` is a healthy read of it. So the
        // word is not enough: the receiver must be DECLARED as a client.
        // Anything else declared in the file is a value; a receiver with no
        // visible declaration is UNCLASSIFIED, never silently skipped
        // (adversarial review on PR #92).
        const ctx: Ctx = { sf, checker, file, queryLine: lineOf(sf, auth.token), followed };
        const declared = declaredAsClient(ctx, auth.receiver);
        if (declared === "client") seen(n, auth.receiver, auth.token);
        else if (declared === "unknown") {
          sites.push(site(ctx, n, "UNCLASSIFIED", `\`.auth\` on \`${auth.receiver.getText(sf)}\`, whose declaration the gate cannot see`));
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

/** Every supabase-js query in `text`, classified. `file` is only for reporting. */
export function classifySource(text: string, file: string): Site[] {
  const program = programOver(new Map([[file, text]]));
  const sf = program.getSourceFile(file);
  if (!sf) throw new Error(`could not parse ${file}`);
  return classifyFile(program, sf, file);
}

function scan(): { files: string[]; sites: Site[] } {
  const files = sourceFiles(FUNCTIONS);
  const program = programOver(new Map(files.map((f) => [f, readFileSync(f, "utf8")])));
  const sites = files.flatMap((f) => {
    const sf = program.getSourceFile(f);
    if (!sf) throw new Error(`could not parse ${f}`);
    return classifyFile(program, sf, relative(ROOT, f));
  });
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

  it("DISCARDED: `error` bound and never read (Codex, PR #92)", () => {
    // Naming the error in the pattern and then treating the envelope as data
    // is the original defect wearing the fix's clothes; the local must be
    // referenced afterwards.
    const s = one(`async function f(db: any) {
  const { data, error } = await db.from("clients").select("id").maybeSingle();
  return data;
}`);
    expect(s.verdict).toBe("DISCARDED");
    expect(s.reason).toMatch(/`error` bound as `error` and never read/);
    const aliased = one(`async function f(db: any) {
  const { data, error: e } = await db.rpc("fn_x", {});
  return data;
}`);
    expect(aliased.verdict).toBe("DISCARDED");
    expect(aliased.reason).toMatch(/bound as `e` and never read/);
  });

  it("assignment form: `({ error } = await q)` is OK when read and DISCARDED when not", () => {
    const read = one(`async function f(db: any) {
  let error: unknown;
  ({ error } = await db.from("walks").update({ a: 1 }).eq("id", "x"));
  if (error) throw error;
}`);
    expect(read.verdict).toBe("OK");
    const unread = one(`async function f(db: any) {
  let error: unknown;
  ({ error } = await db.from("walks").update({ a: 1 }).eq("id", "x"));
}`);
    expect(unread.verdict).toBe("DISCARDED");
    expect(unread.reason).toMatch(/assigned to `error` and never read/);
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
    // Receivers DECLARED as clients: a factory initialiser, a typed parameter,
    // and the factory called inline.
    const sites = classifySource(`async function f(db: ReturnType<typeof adminClient>) {
  const probe = createClient("u", "k");
  const { error } = await probe.auth.signInWithPassword({ email: "a", password: "b" });
  if (error) return false;
  await db.auth.admin.createUser({ email: "a" });
  const { data, error: e2 } = await adminClient().auth.getUser("t");
  if (e2) throw e2;
  return data;
}`, "f.ts");
    expect(sites.map((s) => s.verdict)).toEqual(["OK", "DISCARDED", "OK"]);
    // The two shapes the first run of this gate mistook for GoTrue calls.
    expect(classifySource(`function g(keys: { auth: string }, sub: { auth: string }) {
  const secret = decode(keys.auth);
  return { p256dh: "x", auth: sub.auth, secret };
}`, "f.ts")).toEqual([]);
  });

  it("`.auth.<member>` on a value is a field read, on an undeclared receiver it is UNCLASSIFIED", () => {
    // `auth` is the push encryption secret's field name in this tree, so a
    // member read on it (`sub.auth.length`) is healthy code and must not go
    // red (adversarial review on PR #92). Only a receiver declared as a
    // client is a GoTrue chain; one with no visible declaration is refused
    // loudly rather than skipped.
    expect(classifySource(`function g(sub: { auth: string }, payload: any) {
  const n = sub.auth.length;
  const t = payload.auth?.token;
  return n + t;
}`, "f.ts")).toEqual([]);
    // A call that is not a known client factory could be either — a wrapper
    // returning a client, or a value — so it is refused loudly rather than
    // guessed; adding a real factory to CLIENT_FACTORIES is the remedy.
    expect(classifySource(`function k() { return keysOf().auth.trim(); }`, "f.ts").map((s) => s.verdict)).toEqual(["UNCLASSIFIED"]);
    const s = one(`async function h() {
  const { data } = await client.auth.getUser("t");
  return data;
}`);
    expect(s.verdict).toBe("UNCLASSIFIED");
    expect(s.reason).toMatch(/whose declaration the gate cannot see/);
  });

  it("element-access spelling `db[\"from\"](…)` is the same query", () => {
    const s = one(`async function f(db: any) {
  const { data } = await db["from"]("clients").select("id").maybeSingle();
  return data;
}`);
    expect(s.verdict).toBe("DISCARDED");
  });

  it("an inline callback's arrow body is UNCLASSIFIED, not passed on", () => {
    // `Promise.all(ids.map((id) => db.from(…)…))` drops every envelope into
    // an array nothing reads; the array-literal spelling was already
    // UNCLASSIFIED and `.map` must not be the quiet route round it.
    const sites = classifySource(`async function f(db: any, ids: string[]) {
  await Promise.all(ids.map((id) => db.from("x").delete().eq("id", id)));
  await Promise.all(ids.map(async (id) => await db.from("y").delete().eq("id", id)));
  return later().then(() => db.rpc("fn_z", {}));
}`, "f.ts");
    expect(sites.map((s) => s.verdict)).toEqual(["UNCLASSIFIED", "UNCLASSIFIED", "UNCLASSIFIED"]);
    expect(sites[0]!.reason).toMatch(/inline callback/);
    // An arrow that is NOT a call argument — a property of a deps object,
    // the `unsubscribe` shape — still hands its envelope to a visible caller.
    expect(classifySource(`const deps = { suppress: async (t: string) => await adminClient().rpc("fn_x", { p: t }) };`, "f.ts")
      .map((s) => s.verdict)).toEqual(["PASSED_ON"]);
  });

  it("an envelope variable overwritten before its `.error` is read is DISCARDED for the first query", () => {
    const sites = classifySource(`async function f(db: any) {
  let r = await db.from("a").select("id").maybeSingle();
  r = await db.from("b").select("id").maybeSingle();
  if (r.error) throw r.error;
  return r.data;
}`, "f.ts");
    expect(sites.map((s) => [s.line, s.verdict])).toEqual([[2, "DISCARDED"], [3, "OK"]]);
    // The loop shape — assigned inside a loop, read after it — stays OK: the
    // read is after the assignment and nothing overwrites it in between.
    expect(classifySource(`async function g(db: any, ids: string[]) {
  let last: any = null;
  for (const id of ids) last = await db.from("a").select("id").eq("id", id).maybeSingle();
  if (last?.error) throw last.error;
}`, "f.ts").map((s) => s.verdict)).toEqual(["OK"]);
  });

  it("a same-named variable in a nested scope does not satisfy the outer envelope", () => {
    const param = one(`async function f(db: any, others: any[]) {
  const r = await db.from("a").select("id").maybeSingle();
  others.forEach((r) => { if (r.error) console.log(r.error); });
  return r.data;
}`);
    expect(param.verdict).toBe("DISCARDED");
    const inner = classifySource(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  const g = async () => {
    const r = await db.from("b").select("id").maybeSingle();
    if (r.error) throw r.error;
  };
  await g();
  return r.data;
}`, "f.ts");
    expect(inner.map((s) => [s.line, s.verdict])).toEqual([[2, "DISCARDED"], [4, "OK"]]);
  });

  it("a same-named variable in a nested BLOCK does not satisfy the outer envelope (Codex, PR #92)", () => {
    // Codex's exact case: a block-local `const r` whose `.error` is read.
    const block = one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  { const r = { error: null }; if (r.error) {} }
  return r.data;
}`);
    expect(block.verdict).toBe("DISCARDED");
    // The other block-scoped binders: a loop variable and a catch binding.
    const loop = one(`async function f(db: any, rows: any[]) {
  const r = await db.from("a").select("id").maybeSingle();
  for (const r of rows) { if (r.error) throw r.error; }
  return r.data;
}`);
    expect(loop.verdict).toBe("DISCARDED");
    const caught = one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  try { risky(); } catch (r) { if (r.error) throw r.error; }
  return r.data;
}`);
    expect(caught.verdict).toBe("DISCARDED");
  });

  it("healthy shapes the scope model must keep OK: a query declared inside a block, read in a nested block, or in a loop", () => {
    // The declaration lives in a nested block and is read there (the scope
    // rule must search from the DECLARING scope, not skip it).
    expect(one(`async function f(db: any, c: boolean) {
  if (c) {
    const r = await db.from("a").select("id").maybeSingle();
    if (r.error) throw r.error;
    return r.data;
  }
  return null;
}`).verdict).toBe("OK");
    // Declared outside, read inside a block that does NOT redeclare it.
    expect(one(`async function f(db: any, c: boolean) {
  const r = await db.from("a").select("id").maybeSingle();
  if (c) { if (r.error) throw r.error; }
  return r.data;
}`).verdict).toBe("OK");
    // `var` is function-scoped: a var in a nested block is the SAME variable.
    expect(one(`async function f(db: any) {
  var r = await db.from("a").select("id").maybeSingle();
  { var r2 = r; if (r2.error) throw r2.error; }
  return r.data;
}`).verdict).toBe("OK");
    // A catch clause whose binding is a different name does not hide the read.
    expect(one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  try { if (r.error) throw r.error; } catch (e) { report(e); }
}`).verdict).toBe("OK");
  });

  it("a destructured `error` overwritten before it is read is DISCARDED (Codex, PR #92)", () => {
    const s = one(`async function f(db: any) {
  let { data, error } = await db.from("a").select("id").maybeSingle();
  error = null;
  if (error) throw error;
  return data;
}`);
    expect(s.verdict).toBe("DISCARDED");
    expect(s.reason).toMatch(/bound as `error` and never read/);
    // Read BEFORE the write is still a read.
    expect(one(`async function f(db: any) {
  let { data, error } = await db.from("a").select("id").maybeSingle();
  if (error) { error = normalise(error); throw error; }
  return data;
}`).verdict).toBe("OK");
  });

  it("writing `.error` is not reading it (Codex, PR #92)", () => {
    const written = one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  r.error = null;
  return r.data;
}`);
    expect(written.verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  delete r.error;
  return r.data;
}`).verdict).toBe("DISCARDED");
    // A read before the write still counts; a read AFTER it does not.
    expect(one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  if (r.error) { log(r.error); r.error = null; }
  return r.data;
}`).verdict).toBe("OK");
    expect(one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  r.error ??= null;
  if (r.error) throw r.error;
  return r.data;
}`).verdict).toBe("DISCARDED");
  });

  it("`var` loop bindings and `var` re-declarations are WRITES to the function binding (Codex, PR #92)", () => {
    // Codex's exact case: `for (var r of rows)` re-assigns the same `r`.
    expect(one(`async function f(db: any, rows: any[]) {
  var r = await db.from("a").select("id").maybeSingle();
  for (var r of rows) { if (r.error) throw r.error; }
  return r.data;
}`).verdict).toBe("DISCARDED");
    // A `var` re-declaration in a nested block is the same variable, overwritten.
    expect(one(`async function f(db: any, other: any) {
  var r = await db.from("a").select("id").maybeSingle();
  { var r = other; }
  if (r.error) throw r.error;
}`).verdict).toBe("DISCARDED");
    // A bare loop target is a write too.
    expect(one(`async function f(db: any, rows: any[]) {
  let r = await db.from("a").select("id").maybeSingle();
  for (r of rows) { if (r.error) throw r.error; }
}`).verdict).toBe("DISCARDED");
    // Read BEFORE the loop overwrites it: still a read.
    expect(one(`async function f(db: any, rows: any[]) {
  var r = await db.from("a").select("id").maybeSingle();
  if (r.error) throw r.error;
  for (var r of rows) { use(r); }
}`).verdict).toBe("OK");
  });

  it("a `.error` write through one alias closes the window for every alias (Codex, PR #92)", () => {
    expect(one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  const copy = r;
  r.error = null;
  if (copy.error) throw copy.error;
  return copy.data;
}`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  const copy = r;
  copy.error = null;
  if (r.error) throw r.error;
  return r.data;
}`).verdict).toBe("DISCARDED");
    // Two hops, read through the second: the same object, OK.
    const two = one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  const copy = r;
  const again = copy;
  if (again.error) throw again.error;
  return r.data;
}`);
    expect(two.verdict).toBe("OK");
    expect(two.reason).toMatch(/through alias `again`/);
  });

  it("an `.auth` receiver resolves to its LEXICAL binding, not the first same-named declaration (Codex, PR #92)", () => {
    // Codex's exact case: a block-local `db` earlier in the function is a
    // different binding; the checker's symbol says so, a name search did not.
    const s = one(`async function f(value: unknown, token: string) {
  { const db = value; use(db); }
  const db = adminClient();
  const { data } = await db.auth.getUser(token);
  return data;
}`);
    expect(s.verdict).toBe("DISCARDED");
  });

  it("a bracketed `.error` write closes the window too (Codex, PR #92)", () => {
    expect(one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  r["error"] = null;
  if (r.error) throw r.error;
  return r.data;
}`).verdict).toBe("DISCARDED");
    // …and a bracketed read is a read.
    expect(one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  if (r["error"]) throw r["error"];
  return r.data;
}`).verdict).toBe("OK");
  });

  it("a destructuring ASSIGNMENT is a write (Codex, PR #92)", () => {
    expect(one(`async function f(db: any, other: any) {
  let r = await db.from("a").select("id").maybeSingle();
  ({ r } = other);
  if (r.error) throw r.error;
  return r.data;
}`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, other: any) {
  let r = await db.from("a").select("id").maybeSingle();
  [r] = other;
  if (r.error) throw r.error;
}`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, other: any) {
  let r = await db.from("a").select("id").maybeSingle();
  ({ x: r } = other);
  if (r.error) throw r.error;
}`).verdict).toBe("DISCARDED");
  });

  it("`.auth` receiver declarations: module-level, assigned later, aliased type, destructured, class member", () => {
    // A module-level client used inside a function resolves to the same
    // symbol; `let db; db = adminClient()` is a client by its later
    // assignment; a one-alias-deep type still says client.
    const sites = classifySource(`const db = adminClient();
type Db = ReturnType<typeof adminClient>;
async function a(token: string) { const { data } = await db.auth.getUser(token); return data; }
async function b(token: string) { let c; c = adminClient(); const { data } = await c.auth.getUser(token); return data; }
async function d(client: Db, token: string) { const { data } = await client.auth.getUser(token); return data; }`, "f.ts");
    expect(sites.map((s) => s.verdict)).toEqual(["DISCARDED", "DISCARDED", "DISCARDED"]);
    // A destructured parameter hides its type; a class member is not a
    // declaration the gate reads. Both are refused loudly, never skipped.
    const loud = classifySource(`class S { db: any; async g(token: string) { const { data } = await this.db.auth.getUser(token); return data; } }
async function h({ db }: { db: unknown }, token: string) { const { data } = await db.auth.getUser(token); return data; }`, "f.ts");
    expect(loud.map((s) => s.verdict)).toEqual(["UNCLASSIFIED", "UNCLASSIFIED"]);
  });

  it("a chain ending in .throwOnError() has no envelope to discard", () => {
    // postgrest-js throws on failure here, so a bare await is the correct
    // shape and must not be a red on healthy code.
    const sites = classifySource(`async function f(db: any) {
  await db.from("a").update({ x: 1 }).eq("id", "k").throwOnError();
  let q = db.from("b").select("id");
  q = q.eq("id", "k");
  const { data } = await q.throwOnError();
  return data;
}`, "f.ts");
    expect(sites.map((s) => s.verdict)).toEqual(["OK", "OK"]);
  });

  it("parenthesised, cast and non-null awaits are transparent; `.error` read directly is a read", () => {
    const sites = classifySource(`async function f(db: any) {
  if ((await db.from("a").select("id")).error) throw new Error("x");
  const e = ((await db.from("b").select("id")) as { error: unknown }).error;
  const { data, error } = (await db.from("c").select("id"))!;
  if (error) throw error;
  (await db.from("d").select("id")).error = null;
  return [e, data];
}`, "f.ts");
    expect(sites.map((s) => s.verdict)).toEqual(["OK", "OK", "OK", "DISCARDED"]);
  });

  it("a read of the outer envelope inside a nested closure is a read of the same binding", () => {
    expect(one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  const failed = () => r.error !== null;
  if (failed()) throw r.error;
  return r.data;
}`).verdict).toBe("OK");
  });

  it("an envelope variable passed to a call is UNCLASSIFIED, not passed on", () => {
    const s = one(`async function f(db: any) {
  const r = await db.from("y").select("id");
  console.log(r);
  return r.data;
}`);
    expect(s.verdict).toBe("UNCLASSIFIED");
    expect(s.reason).toMatch(/passed to a call/);
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
