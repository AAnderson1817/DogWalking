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
 * `{ data, error }` value and never by rejecting (unless a builder carries
 * `.throwOnError()`, which nothing here uses and this gate refuses — see
 * below) — so `const { data } = await db.from(…)` reads a dead database as an
 * empty table. The rule had been stated in this repository's log three times
 * — `feat(push)`'s fifth and sixteenth Codex rounds (`dropSubscription`,
 * `noteFailure`) and `money(send-once)`'s deferral of the item this file
 * closes — and enforced by nothing: `getClient` in send-notification turned
 * a transient blip into the TERMINAL skip "client has no email address",
 * permanently cancelling a `payment_failed` email. A rule written down and
 * connected to nothing; this file is the connection.
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
 *                 the same object, where a write inside a closure counts
 *                 from the closure's creation (or from the binding, for a
 *                 hoisted declaration) and a read inside a closure counts
 *                 only when no write can follow the binding at all AND
 *                 every closure around it is visibly invoked (an IIFE, or
 *                 a named function called from straight-line code of the
 *                 same body or from closures that are themselves visibly
 *                 invoked), since the closure runs whenever it is called,
 *                 which may be never — or `.error` is read straight off the
 *                 awaited expression AND used (consumed in place, or bound
 *                 to a local that is read afterwards — `const e = (await
 *                 q).error; return data;` is the destructured discard with
 *                 more parentheses), or a deferred builder (`let q =
 *                 db.from(…)`) is followed to the statement that awaits it
 *                 and THAT is OK. A reference in a DISCARD position — a bare
 *                 statement, `void e`, the left side of a comma — is not a
 *                 read of anything, for a bound `error`, an envelope's
 *                 `.error` and the direct read alike; and a reference merely
 *                 COPIED into a local (`const copy = error`, `copy = error`)
 *                 or STORED in a literal (`{ error }`, `[error]`) is a read
 *                 only if the copy or the literal is itself read,
 *                 transitively, under the copy's own window — and a
 *                 literal is read only through the MEMBER that carries the
 *                 error (`box.error`, `const { error } = box`) or handed on
 *                 whole (a call, a return, a throw); `box.data` reads
 *                 nothing. A class field initializer is deferred
 *                 execution and reads nothing. A closure's
 *                 call site counts only while the binding still holds that
 *                 closure — a call after `check = () => null` invokes the
 *                 replacement. And a read counts only on EVERY path: not
 *                 inside a branch that excludes the binding (`if (data)
 *                 log(error)`, `copy ??= error`, a loop body, a `catch`),
 *                 a default initializer — a parameter's, a binding
 *                 element's, a destructuring assignment's — runs only
 *                 when the value it defaults is undefined),
 *                 and not after a conditional `return`/`continue`/`break`
 *                 (`if (!data) return null; …`) — supabase-js supplies
 *                 `data: null` on failure, so a read the failure path skips
 *                 is the discard itself. A `throw` is not an exit: it aborts
 *                 the request rather than completing it as an absence.
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
 *                 variable passed to a call (`console.log(r)`), a chain
 *                 carrying `.throwOnError()` (it REJECTS with a raw
 *                 PostgrestError that nothing decides — not one of spec 04's
 *                 three shapes, and a route around the CI check that every
 *                 `HttpError(5xx, …)` carries a cause and a context), a
 *                 builder method referenced and never called
 *                 (`.delete().throwOnError` — nothing runs), a deferred
 *                 builder REPLACED before anything consumed it (`let q =
 *                 db.from(…); q = other; await q` — the query never runs;
 *                 `q = q.eq(…)` grows the same builder and is followed), an
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
 * declaration its SYMBOL resolves to, in three answers. A CLIENT:
 * `adminClient()` / `createClient(…)` called inline or awaited, a variable
 * initialised from one (at declaration, as a parameter default, or by a
 * later assignment — and a factory WINS over an annotation naming
 * something else, `const db: Db = adminClient()` being a client whatever
 * `Db` is), an alias of a client — `const authDb = db` — followed
 * transitively (Codex on PR #92: the first version called an untyped alias
 * a value and skipped it, then let a value-typed annotation return before
 * the initialiser was looked at), or a parameter or variable TYPED as one,
 * one type alias deep. A VALUE,
 * which needs POSITIVE evidence: a type annotation naming something that is
 * not a client and is not opaque (`any`, `unknown`, `object`, `{}` say
 * nothing; `Deps["db"]` and `typeof x` would have to be evaluated), a
 * literal initialiser, or an alias of a value — so `sub.auth.length` on
 * `sub: { auth: string }` is a healthy read. Everything else is UNKNOWN: an
 * untyped parameter, an initialiser the gate cannot read (`deps.db`, a call
 * that is not a known factory), a destructured binding, an import, a class
 * member. A GoTrue chain is always CALLED (`.auth.getUser(…)`,
 * `.auth.admin.createUser(…)`), so on an unknown receiver a `.auth.<member>`
 * chain that reaches a call is UNCLASSIFIED — loud, never skipped, and
 * typing the receiver is the remedy — while a bare read (`payload.auth?.
 * token`) is a field read whatever the receiver is. A namespace handed off
 * whole (`const a = db.auth`) is therefore invisible here, the same blind
 * spot as a builder passed to another function; stated, not chased. So is
 * supabase-js's `auth.throwOnError` client option: it makes `.auth.*` calls
 * reject instead of resolving an envelope, `_lib/admin.ts` does not set it
 * and says why, and a call site cannot tell. No `.storage.` call exists
 * anywhere under `supabase/functions/`, so nothing is built for one. For
 * `.from` / `.rpc` the receiver is the supabase client when it is a
 * lowercase identifier — `db`, which every function either creates with
 * `adminClient()` or takes as a parameter typed `ReturnType<typeof
 * adminClient>` / `SupabaseClient` / a structural `{ rpc() }`, and `probe`,
 * a `createClient(…)` in credential-vault — or a direct `adminClient()` /
 * `createClient(…)` call. A CAPITALISED identifier is a global and is not a
 * query: `Uint8Array.from(binary, …)` in `_lib/crypto.ts` (`Array.from(` is
 * pinned by fixture; the tree has none). Anything else in receiver position
 * is UNCLASSIFIED, never silently skipped. A lowercase receiver that is not
 * a supabase client would therefore produce a loud, named false red — the
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
/**
 * A chain carrying this modifier REJECTS with a raw `PostgrestError` instead
 * of resolving an envelope. That is not one of spec 04's three accepted
 * shapes: nothing decides the failure, so it reaches `handleRequest`'s catch
 * as "unhandled error" with no `context` — the H14 shape, and a route around
 * the CI check that every `HttpError(5xx, …)` carries a cause and a context.
 * The first version of this gate blessed it as "throws, nothing to discard";
 * the adversarial review on PR #92 argued the opposite and was right, so it
 * is REFUSED by name.
 */
const REJECTING_MODIFIERS = new Set(["throwOnError"]);
const REJECTS_REASON = "carries `.throwOnError()`, which rejects with a raw PostgrestError that nothing decides — " +
  "it would reach `handleRequest` as an unhandled error with no context; bind `error` and throw " +
  "`HttpError(5xx, …, cause, context)` instead";
/** `q.delete().throwOnError` / `db.from("x").select`: a method named and never invoked. */
function uncalledReason(what: string, member: string): string {
  return `${what}: \`.${member}\` is referenced and never called — nothing runs`;
}

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
  // `(db as any).from(…)` is `db.from(…)` with a cast around the receiver.
  let r: ts.Expression = recv;
  while (ts.isParenthesizedExpression(r) || ts.isAsExpression(r) || ts.isNonNullExpression(r) || ts.isSatisfiesExpression(r)) r = r.expression;
  if (ts.isIdentifier(r)) return /^[A-Z]/.test(r.text) ? "global" : "client";
  if (ts.isCallExpression(r) && ts.isIdentifier(r.expression) && CLIENT_FACTORIES.has(r.expression.text)) {
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

interface Chain {
  top: ts.Node;
  /** Consumed through `.then(` / `.catch(` / `.finally(`. */
  thenable?: string;
  /** Carries an invoked `.throwOnError()`. */
  rejects?: boolean;
  /** A builder method referenced and never called, so nothing runs. */
  uncalled?: string;
}

/**
 * Walk from a chain's root to its outermost link.
 *
 * `db.from("x").select("y").eq(…).maybeSingle()` is one expression tree with
 * the root call at the bottom; the consumer is whatever holds the top. A
 * `.then(` on the way up ends the walk with a verdict of its own: the value
 * after it is no longer the envelope. A member of the builder is a method,
 * and a method that is not CALLED runs nothing: `await
 * db.from("walks").delete().throwOnError;` awaits a function value and the
 * delete never happens (Codex on PR #92, which found the first version
 * counting the bare reference as a throwing chain) — so the CALL, not the
 * name, is what makes a link, and a bare reference ends the walk with a
 * verdict of its own. An invoked `.throwOnError()` is remembered and refused
 * by the caller.
 */
function outermost(node: ts.Node): Chain {
  let n = node;
  let rejects = false;
  for (;;) {
    const p: ts.Node = n.parent;
    const m = memberAccess(p);
    if (m && m.receiver === n) {
      const next = p.parent;
      const invoked = ts.isCallExpression(next) && next.expression === p;
      // A namespace hop — `.auth.admin.createUser(…)`, `.auth.mfa.…` — is a
      // property, not a method, and the call comes one link later.
      const hop = memberAccess(next)?.receiver === p;
      if (!invoked && !hop) return { top: p, uncalled: m.name };
      if (invoked && THENABLE.has(m.name)) return { top: p, thenable: m.name };
      if (invoked && REJECTING_MODIFIERS.has(m.name)) rejects = true;
      n = p;
      continue;
    }
    if (ts.isCallExpression(p) && p.expression === n) { n = p; continue; }
    if (isTransparent(p, n)) { n = p; continue; }
    // `q = cond ? q.is(…) : q.eq(…)` — both branches are the same builder.
    if (ts.isConditionalExpression(p) && (p.whenTrue === n || p.whenFalse === n)) { n = p; continue; }
    return { top: n, rejects };
  }
}

/** Does the member chain above `n` reach a call — `n.x(…)`, `n.x.y(…)` — before it ends? */
function chainIsCalled(n: ts.Node): boolean {
  let cur: ts.Node = n;
  for (;;) {
    const p: ts.Node = cur.parent;
    if (ts.isCallExpression(p) && p.expression === cur) return true;
    const m = memberAccess(p);
    if (m && m.receiver === cur) { cur = p; continue; }
    if (isTransparent(p, cur)) { cur = p; continue; }
    return false;
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
function writesTo(checker: ts.TypeChecker, sym: ts.Symbol, container: ts.Node): Write[] {
  const out: Write[] = [];
  const target = (t: ts.Expression) => {
    for (const id of assignmentTargets(t)) if (symbolOf(checker, id) === sym) out.push({ pos: id.pos, node: id });
  };
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && isAssignmentKind(n.operatorToken.kind)) target(n.left);
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isVariableDeclarationList(n.parent) && !isBlockScoped(n.parent) &&
      ts.isIdentifier(n.name) && symbolOf(checker, n.name) === sym) out.push({ pos: n.name.pos, node: n.name });
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      const init = n.initializer;
      if (ts.isVariableDeclarationList(init)) {
        if (!isBlockScoped(init)) {
          for (const d of init.declarations) if (ts.isIdentifier(d.name) && symbolOf(checker, d.name) === sym) out.push({ pos: d.name.pos, node: d.name });
        }
      } else target(init);
    }
    ts.forEachChild(n, visit);
  };
  visit(container);
  return out;
}

/** A write to a binding: where its target sits in the source, and the target itself. */
interface Write { pos: number; node: ts.Node }

/**
 * The outermost function nested inside `container` that encloses `n` — the
 * closure `n` runs in — or null when `n` runs in `container`'s own body.
 */
function closureOf(n: ts.Node, container: ts.Node): ts.Node | null {
  let outermost: ts.Node | null = null;
  for (let cur: ts.Node | undefined = n.parent; cur && cur !== container; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) outermost = cur;
  }
  return outermost;
}

/**
 * Where a write EXECUTES, as far as source order can say. Straight-line code
 * writes where it sits. A write inside a closure runs whenever the closure
 * is CALLED: an arrow or function expression cannot run before it exists,
 * so its creation point is the earliest — and a hoisted function
 * declaration can be called before any read at all, so its write sits at
 * the binding itself and no later read survives it (Codex on PR #92: `const
 * check = () => error; error = null; if (check()) …` reads the null, and a
 * position-only window called the closure's reference an earlier read).
 */
function executesAt(w: Write, container: ts.Node, bound: ts.Identifier): number {
  const fn = closureOf(w.node, container);
  if (!fn) return w.pos;
  return ts.isFunctionDeclaration(fn) ? bound.end : fn.pos;
}

/** The first write to `bound`'s binding that can execute after it, or Infinity. */
function nextWriteTo(checker: ts.TypeChecker, sym: ts.Symbol, container: ts.Node, bound: ts.Identifier): number {
  return Math.min(Infinity, ...writesTo(checker, sym, container).map((w) => executesAt(w, container, bound)).filter((w) => w > bound.pos));
}

/** An expression with its transparent wrappers stripped: `(x)`, `x as T`, `x!`, `x satisfies T`. */
function unwrapped(e: ts.Expression): ts.Expression {
  let r = e;
  while (ts.isParenthesizedExpression(r) || ts.isAsExpression(r) || ts.isNonNullExpression(r) || ts.isSatisfiesExpression(r)) r = r.expression;
  return r;
}

/**
 * `box.nested.cause` — the plain name at the base and the keys from it
 * outward, either spelling, unwrapping a transparent node at EVERY level
 * (`(box).error` is the same member as `box.error`; Codex on PR #92, round
 * eighteen). Null when the base is not a plain name.
 */
function memberChain(target: ts.Expression): { base: ts.Identifier; keys: Key[] } | null {
  const keys: Key[] = [];
  let cur = unwrapped(target);
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) { keys.unshift(cur.name.text); cur = unwrapped(cur.expression); continue; }
    if (ts.isElementAccessExpression(cur)) { keys.unshift(keyOfIndex(cur.argumentExpression)); cur = unwrapped(cur.expression); continue; }
    break;
  }
  return ts.isIdentifier(cur) && keys.length > 0 ? { base: cur, keys } : null;
}

/**
 * Where a name comes FROM: the binding it was ultimately initialised from and
 * the keys between them — `box` is itself, `const inner = box.nested` is
 * `box` plus `["nested"]`, recursively. Two names denote the same object when
 * they share a root and the keys agree, which is what lets a write through
 * one be seen by a read through another (Codex on PR #92, round eighteen).
 *
 * What a name refers to is decided by the LAST write before `at`, so a
 * binding reassigned in between is not what it was initialised from any
 * more and roots at itself: `let alias = box; alias = other; alias.error =
 * null;` writes to another object entirely, and treating it as `box` forever
 * rejected correct code (Codex, round nineteen — the worst shape a gate has,
 * red on a healthy tree). Assignment is provenance as much as initialisation
 * (round twenty), and an assignment back restores it.
 */
function rootOf(checker: ts.TypeChecker, id: ts.Identifier, container: ts.Node, at: number, seen: Set<ts.Symbol> = new Set()): { sym: ts.Symbol; keys: Key[] } | null {
  const sym = symbolOf(checker, id);
  if (!sym || seen.has(sym)) return null;
  seen.add(sym);
  const self = { sym, keys: [] as Key[] };
  // The LAST place this binding was given a value before `at` decides what it
  // refers to there — a plain assignment as much as a declaration's
  // initialiser (Codex on PR #92, round twenty: `let alias: T; alias = box;`
  // is provenance too), and a write of any other shape leaves it unknown.
  // Only a write whose execution is CERTAIN can say what a name refers to: an
  // assignment inside a closure may never run, and `executesAt` puts it at the
  // closure's creation, which is right for "this may have happened by now" and
  // wrong for "this decided what the name is" — it reported a genuine read
  // DISCARDED (Codex on PR #92, round twenty-one).
  //
  // A write that MIGHT have run is neither, and the two halves of that are
  // what rounds twenty-one and twenty-two are: a closure the gate cannot see
  // invoked CANNOT run, so it neither gives provenance nor takes it away,
  // while a write in a branch — or in a closure that IS invoked — leaves the
  // name unknown, which is null here and makes the caller treat a write
  // through it as possibly landing on the error (Codex, round twenty-two:
  // filtering those out instead let the declaration answer as though the
  // branch could never be taken).
  const before = writesTo(checker, sym, container)
    .map((w) => ({ pos: executesAt(w, container, id), node: w.node }))
    .filter((w) => w.pos < at);
  const live = before.filter((w) => {
    const fn = closureOf(w.node, container);
    return fn === null || visiblyInvoked(fn, container, checker, id);
  });
  const definite = live.filter((w) => closureOf(w.node, container) === null && established(w.node, id, container));
  const latest = definite.sort((a, b) => b.pos - a.pos)[0];
  // An uncertain write SUPERSEDED by a definite one no longer decides
  // anything: `if (c) alias = other; alias = other2;` ends certain, and
  // calling it unknown was a red on healthy code (Codex on PR #92, round
  // twenty-three). A live CLOSURE write is not ordered against anything —
  // its position is where it was created, not where it is called — so it
  // stays pessimistic.
  const uncertain = live.some((w) =>
    closureOf(w.node, container) !== null ||
    (!established(w.node, id, container) && (!latest || w.pos > latest.pos)));
  if (uncertain) return null;
  const writes = definite.sort((a, b) => b.pos - a.pos);
  const last = writes[0];
  let source: { pos: number; expr: ts.Expression } | null = null;
  if (last) {
    // `(alias) = box` is the same assignment: the target wears the wrappers
    // `memberChain` already climbs on the other side (Codex, round twenty-one).
    const target = forwardedTo(last.node);
    const p = target.parent;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === target) {
      source = { pos: last.pos, expr: p.right };
    } else if (ts.isVariableDeclaration(p) && p.name === target && p.initializer) {
      source = { pos: last.pos, expr: p.initializer };
    }
  } else {
    const d = (sym.declarations ?? []).find((x) => ts.isVariableDeclaration(x) && x.initializer !== undefined);
    if (d && ts.isVariableDeclaration(d) && d.initializer) source = { pos: d.pos, expr: d.initializer };
  }
  if (!source) return self;
  const init = unwrapped(source.expr);
  const from = ts.isIdentifier(init) ? { base: init, keys: [] as Key[] } : memberChain(init);
  if (!from) return self;
  // Resolved AS OF the copy: a name that took the reference before the name it
  // copied moved on still holds the object it copied.
  const up = rootOf(checker, from.base, container, source.pos, seen);
  if (!up) return self;
  return { sym: up.sym, keys: [...up.keys, ...from.keys] };
}

/**
 * The next write that REPLACES the error at `path` — `box.error = fallback`,
 * `box["error"] ??= …`, `box.nested.cause = fallback`, `delete box.cause`, a
 * write through a key the gate cannot read, or any of those through another
 * name for the same object. A value that CARRIES the error stops carrying it
 * once the member the path names is replaced, which is the in-literal
 * override (round seventeen) one statement later.
 *
 * A write is a replacement when its key chain is a PREFIX of the carried path
 * (the whole of it included): a write DEEPER than the path mutates a field of
 * the error and leaves the error itself where it is, and one that diverges at
 * any key touches another member entirely.
 */
function nextPropertyWriteTo(checker: ts.TypeChecker, container: ts.Node, bound: ts.Identifier, path: Path): number {
  if (path.length === 0) return Infinity;
  const here = rootOf(checker, bound, container, bound.pos);
  if (!here) return Infinity; // the read side itself unknown: the binding-write window still applies
  // Where the error sits, said from the root: the keys to this binding, then
  // the path it carries.
  const carriedFromRoot = [...here.keys, ...path];
  const out: Write[] = [];
  const hits = (target: ts.Expression) => {
    const chain = memberChain(target);
    if (!chain) return;
    const from = rootOf(checker, chain.base, container, target.pos);
    if (from && from.sym !== here.sym) return;
    const along = (written: Key[], depth: number): boolean => {
      if (depth + written.length > carriedFromRoot.length) return false;
      return written.every((w, i) => {
        const c = carriedFromRoot[depth + i]!;
        return w === UNKNOWN || c === UNKNOWN || String(w) === String(c);
      });
    };
    if (from) {
      if (!along([...from.keys, ...chain.keys], 0)) return;
    } else {
      // A base the gate cannot resolve MIGHT be this object — at ANY depth
      // along the path, since an unknown name can just as well hold the
      // nested carrier (Codex on PR #92, rounds twenty-two and twenty-three):
      // refused rather than assumed away.
      let possible = false;
      for (let d = 0; d <= carriedFromRoot.length && !possible; d += 1) possible = along(chain.keys, d);
      if (!possible) return;
    }
    out.push({ pos: target.pos, node: target });
  };
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && isAssignmentKind(n.operatorToken.kind)) hits(n.left);
    if (ts.isDeleteExpression(n)) hits(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(container);
  return Math.min(Infinity, ...out.map((w) => executesAt(w, container, bound)).filter((w) => w > bound.pos));
}

/** Every function nested inside `container` that encloses `n`, outermost first. */
function closuresAround(n: ts.Node, container: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  for (let cur: ts.Node | undefined = n.parent; cur && cur !== container; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) out.unshift(cur);
  }
  return out;
}

/**
 * Is this closure CALLED where the gate can see it — an IIFE, or a function
 * bound to a name (a variable's initializer, a function declaration) that is
 * invoked from straight-line code of `container`, or from closures that are
 * themselves visibly invoked, all the way out? A callback handed to a call,
 * a closure returned or stored on an object may never run, and a read inside
 * a closure that never runs is no read: `const check = () => error; return
 * data;` discards the error with the closure never invoked (Codex on PR #92,
 * the round after the closure's TIMING was fixed) — and so does `const check
 * = () => error; const never = () => check(); return data;`, where the call
 * exists and never executes (Codex, one round later). `seen` breaks cycles:
 * two closures that only call each other reach straight-line code nowhere.
 * `anchor` is where the path the call must lie on begins — the read's
 * binding for a straight-line call, the enclosing closure for a nested one.
 */
function visiblyInvoked(fn: ts.Node, container: ts.Node, checker: ts.TypeChecker, anchor: ts.Node, seen: Set<ts.Node> = new Set()): boolean {
  if (seen.has(fn)) return false;
  seen.add(fn);
  let top: ts.Node = fn;
  while (top.parent && isTransparent(top.parent, top)) top = top.parent;
  const p = top.parent;
  if (ts.isCallExpression(p) && p.expression === top) return true;
  let name: ts.Identifier | undefined;
  if (ts.isVariableDeclaration(p) && p.initializer === top && ts.isIdentifier(p.name)) name = p.name;
  else if (ts.isFunctionDeclaration(fn) && fn.name) name = fn.name;
  if (!name) return false;
  const sym = symbolOf(checker, name);
  if (!sym) return false;
  // A call invokes whatever the NAME holds when it runs, which is this
  // closure only until the binding's next write: `let check = () => error;
  // check = () => null; if (check()) …` calls the replacement, and a call
  // resolved by symbol alone counted it as this closure's (Codex on PR #92,
  // round twelve). So the same window a read gets — a straight-line call
  // before the first write that can execute after the binding (a hoisted
  // declaration is live from the top, so every write bounds it), and a call
  // inside a closure only when no write can follow the binding at all,
  // since that closure runs after any later write.
  const hoisted = ts.isFunctionDeclaration(fn);
  const bound = name;
  const writes = writesTo(checker, sym, container).map((w) => executesAt(w, container, bound));
  const overwritten = Math.min(Infinity, ...writes.filter((w) => hoisted || w > bound.pos));
  const callSites: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n !== name && symbolOf(checker, n) === sym) {
      let t: ts.Node = n;
      while (t.parent && isTransparent(t.parent, t)) t = t.parent;
      if (ts.isCallExpression(t.parent) && t.parent.expression === t) callSites.push(t.parent);
    }
    ts.forEachChild(n, visit);
  };
  visit(container);
  // A call site executes only if every closure around IT executes — and
  // only on every path: a call inside a branch, or after a conditional
  // exit from the anchor (the read's binding, or the closure the call sits
  // in), establishes nothing.
  return callSites.some((c) => {
    if ((!hoisted && c.pos <= bound.pos) || c.pos >= overwritten) return false;
    const around = closuresAround(c, container);
    if (around.length === 0) return established(c, anchor, container);
    const inner = around[around.length - 1]!;
    return overwritten === Infinity && established(c, inner, inner) &&
      around.every((f) => visiblyInvoked(f, container, checker, anchor, seen));
  });
}

/** Does `outer` contain `inner` (or equal it)? */
function contains(outer: ts.Node, inner: ts.Node): boolean {
  for (let cur: ts.Node | undefined = inner; cur; cur = cur.parent) if (cur === outer) return true;
  return false;
}

/** Is this `=` a DEFAULT inside a destructuring-assignment pattern — `({ e = error } = obj)`, `[e = error] = arr` — rather than an assignment? */
function isPatternDefault(assignment: ts.BinaryExpression): boolean {
  let cur: ts.Node = assignment;
  for (;;) {
    const p: ts.Node = cur.parent;
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p) || ts.isSpreadElement(p)) {
      cur = p;
      continue;
    }
    if (ts.isObjectLiteralExpression(p) || ts.isArrayLiteralExpression(p)) {
      const holder = p.parent;
      if (ts.isBinaryExpression(holder) && holder.left === p && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
      if ((ts.isForOfStatement(holder) || ts.isForInStatement(holder)) && holder.initializer === p) return true;
      cur = p;
      continue;
    }
    return false;
  }
}

/**
 * Is `child` a BRANCH of `parent` — a position that runs only when some
 * condition holds? The body of an `if`/`else`, either arm of `?:`, the right
 * side of `&&`/`||`/`??` and of the logical assignments `??=`/`||=`/`&&=`
 * (which evaluate their right side only conditionally — `copy ??= error`
 * never looks at the error when `copy` is set, Codex on PR #92), a `case`,
 * a loop body (a `do` body runs at least once), a `catch` clause, the
 * arguments of an optional-chain call (`x?.log(error)`), and a DEFAULT
 * initializer — a parameter's (`function check(x = error)` skips it when
 * the call supplies an argument, Codex on PR #92, round fourteen), a
 * binding element's (`const { e = error } = obj`) and a destructuring
 * assignment's (`({ e = error } = obj)`) — which runs only when the value
 * it defaults is undefined.
 */
function isBranchEdge(parent: ts.Node, child: ts.Node): boolean {
  // A class field's initializer runs per CONSTRUCTION (or, static, when the
  // class is evaluated) and lands on an object nothing here follows — `class
  // Never { field = error }` reads nothing with `Never` never built (Codex on
  // PR #92, round fifteen). Refused for both kinds: construction is execution
  // the gate cannot see, and a static field is a store the gate cannot follow.
  if (ts.isPropertyDeclaration(parent) && child === parent.initializer) return true;
  if ((ts.isParameter(parent) || ts.isBindingElement(parent)) && child === parent.initializer) return true;
  if (ts.isShorthandPropertyAssignment(parent) && child === parent.objectAssignmentInitializer) return true;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && child === parent.right &&
    isPatternDefault(parent)) return true;
  if (ts.isIfStatement(parent)) return child === parent.thenStatement || child === parent.elseStatement;
  if (ts.isConditionalExpression(parent)) return child === parent.whenTrue || child === parent.whenFalse;
  if (ts.isBinaryExpression(parent)) {
    const k = parent.operatorToken.kind;
    const logical = k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken ||
      k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      k === ts.SyntaxKind.BarBarEqualsToken || k === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
    return logical && child === parent.right;
  }
  if (ts.isCaseClause(child) || ts.isDefaultClause(child)) return true;
  if (ts.isForStatement(parent) || ts.isForOfStatement(parent) || ts.isForInStatement(parent) || ts.isWhileStatement(parent)) {
    return child === parent.statement;
  }
  if (ts.isCatchClause(child)) return true;
  if (ts.isCallExpression(parent) && (parent.flags & ts.NodeFlags.OptionalChain) !== 0) {
    return parent.arguments.some((a) => a === child);
  }
  return false;
}

/**
 * A conditional EXIT between `from` and `to` inside `scope` (nested functions
 * excluded): a `return`, or a `continue`/`break` that leaves a loop, after
 * `from` and before `to`. A read after `if (!data) return null;` runs only
 * on the success path — supabase-js supplies `data: null` on failure, so the
 * one branch that reads `error` is skipped exactly when there is one (Codex
 * on PR #92). A `throw` is deliberately NOT an exit: it aborts the request
 * rather than completing it normally, and normal completion is what turns a
 * failure into an absence.
 */
function exitsBetween(from: ts.Node, to: ts.Node, scope: ts.Node): boolean {
  const start = from === scope ? from.pos : from.end;
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (n !== scope && ts.isFunctionLike(n)) return;
    if (n.pos >= start && n.end <= to.pos) {
      if (ts.isReturnStatement(n) || ts.isContinueStatement(n)) found = true;
      if (ts.isBreakStatement(n)) {
        // A bare `break` inside a `switch` leaves the switch, not the scope.
        let target: ts.Node | undefined = n.parent;
        while (target && target !== scope && !ts.isIterationStatement(target, false) && !ts.isSwitchStatement(target)) target = target.parent;
        if (n.label || !(target && ts.isSwitchStatement(target))) found = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/**
 * Is `n` reached on EVERY path through `scope` that passes `from`: not
 * inside a branch that excludes `from` (`if (data) console.error(error)`
 * reads only on the success path), and with no conditional exit between?
 * The failure the gate exists for is a query error that never gets looked
 * at, and a read the failure path skips is exactly that (Codex on PR #92,
 * round thirteen).
 */
function established(n: ts.Node, from: ts.Node, scope: ts.Node): boolean {
  for (let cur: ts.Node = n; cur !== scope && cur.parent; cur = cur.parent) {
    if (isBranchEdge(cur.parent, cur) && !contains(cur, from)) return false;
  }
  return !exitsBetween(from, n, scope);
}

/**
 * Is this reference a read that observes the binding's value BEFORE the
 * window closes? A straight-line read must sit before the first write that
 * can execute after the binding. A read inside a closure runs when the
 * closure is called — which can be after ANY later write, so it counts only
 * when no write can follow the binding at all, and which may be never, so it
 * counts only when every closure around it is visibly invoked (Codex on PR
 * #92, two rounds).
 */
function readsInWindow(u: ts.Identifier, bound: ts.Identifier, overwritten: number, container: ts.Node, checker: ts.TypeChecker): boolean {
  if (u.pos <= bound.pos || u.pos >= overwritten) return false;
  const closures = closuresAround(u, container);
  if (closures.length === 0) return established(u, bound, container);
  const inner = closures[closures.length - 1]!;
  return overwritten === Infinity && established(u, inner, inner) &&
    closures.every((fn) => visiblyInvoked(fn, container, checker, bound));
}

/**
 * Every READ of the binding `sym` inside `container`: identifiers that
 * resolve to it and are neither its declaration nor a write target. A
 * shadow has a different symbol and is never counted (the whole point).
 */
function usesOf(checker: ts.TypeChecker, sym: ts.Symbol, container: ts.Node): ts.Identifier[] {
  const written = new Set<number>(writesTo(checker, sym, container).map((w) => w.pos));
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
 * Walk up from an expression through what FORWARDS its value unchanged —
 * `(e)`, `e as T`, `e!`, `e satisfies T`, `await e`, the right side of a
 * comma — to the node whose parent finally consumes it.
 */
function forwardedTo(n: ts.Node): ts.Node {
  let holder = n;
  for (;;) {
    const up: ts.Node = holder.parent;
    const forwards = isTransparent(up, holder) || (ts.isAwaitExpression(up) && up.expression === holder) ||
      (ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.CommaToken && up.right === holder);
    if (!forwards) return holder;
    holder = up;
  }
}

/**
 * Does this holder's parent DISCARD the value — an expression statement,
 * `void e`, the left side of a comma? A reference in such a position is not
 * a read of anything: `void error`, `(error, 1)`, a bare `r.error;` (Codex
 * on PR #92, after the same shapes had been closed for the direct read).
 */
function discardedAt(holder: ts.Node): boolean {
  const h = holder.parent;
  return ts.isExpressionStatement(h) || ts.isVoidExpression(h) ||
    (ts.isBinaryExpression(h) && h.operatorToken.kind === ts.SyntaxKind.CommaToken && h.left === holder) ||
    // An assignment TARGET is written, not read: `box.error = fallback`
    // replaces the member and inspects nothing, and `delete box.cause`
    // removes it (Codex on PR #92, round twenty — the finding named missing
    // provenance, and this is what its case was actually passing on). Every
    // assignment kind, the compound ones included: `box.error ??= fallback`
    // does read the member first, but the write window closes at that same
    // position, so calling it a read decides nothing — a distinction no test
    // could hold, which is a rule with nothing behind it.
    (ts.isBinaryExpression(h) && isAssignmentKind(h.operatorToken.kind) && h.left === holder) ||
    (ts.isDeleteExpression(h) && h.expression === holder);
}

/** The local an expression is COPIED into — `const copy = e`, `copy = e` — or null.
 * Plain `=` only: a logical assignment (`copy ??= e`) evaluates its right
 * side conditionally, so the reference there is a branch, not a copy (Codex
 * on PR #92, round thirteen), and `established` refuses it before this runs. */
function aliasTarget(holder: ts.Node): ts.Identifier | null {
  const h = holder.parent;
  if (ts.isVariableDeclaration(h) && h.initializer === holder && ts.isIdentifier(h.name)) return h.name;
  if (ts.isBinaryExpression(h) && h.right === holder && ts.isIdentifier(h.left) && h.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return h.left;
  }
  return null;
}

/** A key the error sits under inside an aggregate: a property name, an array index, or UNKNOWN (a computed key, an index behind a spread). */
const UNKNOWN = Symbol("unknown-key");
type Key = string | number | typeof UNKNOWN;
/** Where the error sits inside the value at hand, outermost key first; empty means the value IS the error. */
type Path = readonly Key[];

/**
 * The key an INDEX expression names — `box["error"]`, `errs[1]` — or UNKNOWN.
 * Not `keyOf`: there an identifier IS the literal name (`{ error: … }`),
 * while here it is a variable whose value the gate cannot know, so reading
 * `box[k]` as the key "k" both missed a computed WRITE that may replace the
 * carried member and answered a computed read for the wrong reason (found by
 * the round-eighteen test, in round fifteen's code).
 */
function keyOfIndex(e: ts.Expression): Key {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  return UNKNOWN;
}

/** The literal name of a property key, or UNKNOWN for a computed one. */
function keyOf(name: ts.PropertyName | ts.Expression): Key {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return Number(name.text);
  return UNKNOWN;
}

/** The array index an element sits at, or UNKNOWN once a spread precedes it. */
function indexOf(list: ts.NodeArray<ts.Node>, element: ts.Node): Key {
  let i = 0;
  for (const e of list) {
    if (e === element) return i;
    if (ts.isSpreadElement(e) || ts.isOmittedExpression(e)) { if (ts.isSpreadElement(e)) return UNKNOWN; }
    i += 1;
  }
  return UNKNOWN;
}

/**
 * The object or array literal an expression is STORED in — `{ error }`,
 * `{ cause: e }`, `[e]`, `{ ...e }` — with the key it sits under, or null.
 * The key is what lets a later read of the literal be held to the MEMBER
 * that carries the error rather than to any member at all (Codex on PR
 * #92, round fifteen: `const box = { error, data }; return box.data;`).
 */
function aggregateHolding(holder: ts.Node): { literal: ts.Node; key: Key | null; element: ts.Node } | null {
  const h = holder.parent;
  if (ts.isPropertyAssignment(h) && h.initializer === holder) return { literal: h.parent, key: keyOf(h.name), element: h };
  if (ts.isShorthandPropertyAssignment(h)) return { literal: h.parent, key: h.name.text, element: h };
  // An object spread copies the keys of its operand through unchanged (`key:
  // null`, resolved against the path at the call site); an array spread
  // scatters them.
  if (ts.isSpreadAssignment(h)) return { literal: h.parent, key: null, element: h };
  if (ts.isArrayLiteralExpression(h)) return { literal: h, key: indexOf(h.elements, holder), element: holder };
  if (ts.isSpreadElement(h) && ts.isArrayLiteralExpression(h.parent)) return { literal: h.parent, key: UNKNOWN, element: h };
  return null;
}

/**
 * Inside one object literal, can an element AFTER `element` define `key`
 * again? The last definition wins, so `const box = { ...carrier, error:
 * fallback }` hands back the fallback and a later `box.error` observes it,
 * never the query's error (Codex on PR #92, round seventeen). A property of
 * the same name, a computed key and a spread of anything all may; an array
 * literal cannot, since a later element shifts no earlier index (and
 * `indexOf` already gives up at a spread).
 */
function mayRedefine(literal: ts.Node, element: ts.Node, key: Key): boolean {
  if (key === UNKNOWN || !ts.isObjectLiteralExpression(literal)) return false;
  let after = false;
  for (const p of literal.properties) {
    if (p === element) { after = true; continue; }
    if (!after) continue;
    if (ts.isSpreadAssignment(p)) return true;
    const k = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)
      ? keyOf(p.name) : UNKNOWN;
    if (k === UNKNOWN || k === key) return true;
  }
  return false;
}

/** Does this consumer take the WHOLE value somewhere the gate cannot follow but a reader plausibly inspects it — a call, a `return`, a `throw`, a `yield`? */
function handedOn(holder: ts.Node): boolean {
  const h = holder.parent;
  return ((ts.isCallExpression(h) || ts.isNewExpression(h)) && (h.arguments?.some((a) => a === holder) ?? false)) ||
    ts.isReturnStatement(h) || ts.isThrowStatement(h) || ts.isYieldExpression(h) ||
    (ts.isArrowFunction(h) && h.body === holder);
}

/**
 * Does destructuring `pattern` from a value that carries the error at
 * `path` reach the error and read it? A rest element carries it on; an
 * element under another key does not (Codex on PR #92, round fifteen:
 * `const { data: d } = box` is a partial read that never touches it).
 */
function patternReads(ctx: Ctx, pattern: ts.BindingPattern, path: Path, seen: Set<ts.Node>): boolean {
  const via = (name: ts.BindingName, p: Path): boolean =>
    ts.isIdentifier(name) ? isReadAfter(ctx, name, seen, p) : patternReads(ctx, name, p, seen);
  // The value itself, taken apart. Each binding carries a piece of the error,
  // so the read is whichever piece is READ — taking it apart and discarding
  // every piece (`const { message } = error; void message;`) inspects
  // nothing. This is the member hop's rule in its sibling: found by checking
  // it after Codex's round-sixteen finding, not by the review.
  if (path.length === 0) {
    return pattern.elements.some((el) => !ts.isOmittedExpression(el) && via(el.name, []));
  }
  const [head, ...rest] = path;
  if (head === UNKNOWN) return false;
  if (ts.isObjectBindingPattern(pattern)) {
    return pattern.elements.some((el) => {
      if (el.dotDotDotToken) return via(el.name, path);
      const key = el.propertyName ? keyOf(el.propertyName) : ts.isIdentifier(el.name) ? el.name.text : UNKNOWN;
      return key === head && via(el.name, rest);
    });
  }
  let i = 0;
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) { i += 1; continue; }
    if (el.dotDotDotToken) return via(el.name, path);
    if (i === head && via(el.name, rest)) return true;
    i += 1;
  }
  return false;
}

/**
 * A reference that is consumed by something — not merely mentioned and
 * thrown away, and not merely COPIED into a local nothing reads. `const copy
 * = error; void copy; return data;` names the error twice and inspects it
 * never (Codex on PR #92, round twelve, after the discard positions were
 * closed): a copy carries the value, so it is followed to a real consumer —
 * transitively, and under the copy's own read window, so a copy that is
 * overwritten or discarded before it is read consumes nothing.
 */
function consumes(ctx: Ctx, n: ts.Node, seen: Set<ts.Node> = new Set(), path: Path = []): boolean {
  const holder = forwardedTo(n);
  if (discardedAt(holder)) return false;
  const h = holder.parent;
  // A member read off a value that CARRIES the error: it counts only along
  // the path the error sits under (`box.error`, then whatever consumes
  // that), never for another member (`box.data`) or a key the gate cannot
  // read (Codex on PR #92, round fifteen).
  if ((ts.isPropertyAccessExpression(h) || ts.isElementAccessExpression(h)) && h.expression === holder) {
    // Reaching the error is not reading it: `void error?.message` names a
    // field and throws the answer away, so the ACCESS is followed by the
    // same rules as anything else (Codex on PR #92, round sixteen — the
    // round-seven discard positions, one hop in). A value derived from the
    // error is the error for this question, so the hop resets the path.
    if (path.length === 0) return consumes(ctx, h, seen, []);
    const key = ts.isPropertyAccessExpression(h) ? h.name.text : keyOfIndex(h.argumentExpression);
    return key !== UNKNOWN && key === path[0] && consumes(ctx, h, seen, path.slice(1));
  }
  const alias = aliasTarget(holder);
  if (alias) return isReadAfter(ctx, alias, seen, path);
  // Stored in an aggregate — `const box = { error }; return data;` — the
  // literal is what must be consumed, by the same rules (Codex on PR #92,
  // round thirteen): passed to a call or thrown it is, bound to a local
  // nothing reads it is not — and the key it sits under travels with it.
  const aggregate = aggregateHolding(holder);
  if (aggregate) {
    // An object spread copies its operand's keys through, so a path INTO a
    // carrier survives it — but spreading the ERROR itself scatters that
    // error's own fields under names the gate cannot enumerate, so no later
    // member read can be held to them and only handing the literal on whole
    // counts (Codex on PR #92, round sixteen: `const box = { ...error, data
    // }; return box.data;`).
    const carried: Path = aggregate.key === null
      ? (path.length === 0 ? [UNKNOWN] : path)
      : [aggregate.key, ...path];
    // …and only while the rest of the literal leaves that key alone.
    const head = carried[0];
    const kept: Path = head !== undefined && mayRedefine(aggregate.literal, aggregate.element, head)
      ? [UNKNOWN, ...carried.slice(1)]
      : carried;
    return consumes(ctx, aggregate.literal, seen, kept);
  }
  // Taken apart by a pattern: `const { error: e } = box`.
  if (ts.isVariableDeclaration(h) && h.initializer === holder && !ts.isIdentifier(h.name)) {
    return patternReads(ctx, h.name, path, seen);
  }
  // The value itself, consumed by anything else, is read. A value that only
  // CARRIES the error is read only when handed on whole — a call, a return,
  // a throw — not when its truthiness or identity is what the consumer wants.
  return path.length === 0 || handedOn(holder);
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
function isReadAfter(ctx: Ctx, bound: ts.Identifier, seen: Set<ts.Node> = new Set(), path: Path = []): boolean {
  // Before the local is overwritten: `let { error } = await q; error = null;
  // if (error) …` reads the null, not the query's error (Codex on PR #92).
  // `seen` guards the copy-following recursion in `consumes`: every hop lands
  // on a later binding, so a cycle cannot form, and the guard makes that a
  // property rather than a hope.
  if (seen.has(bound)) return false;
  seen.add(bound);
  const sym = symbolOf(ctx.checker, bound);
  if (!sym) return false;
  const container = scopeContainer(bound);
  const overwritten = Math.min(
    nextWriteTo(ctx.checker, sym, container, bound),
    nextPropertyWriteTo(ctx.checker, container, bound, path),
  );
  return usesOf(ctx.checker, sym, container).some((u) =>
    readsInWindow(u, bound, overwritten, container, ctx.checker) && consumes(ctx, u, seen, path)
  );
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
  interface Member { id: ts.Identifier; uses: ts.Identifier[]; every: ts.Identifier[] }
  const members: Member[] = [];
  const queue: ts.Identifier[] = [nameNode];
  const seenSym = new Set<ts.Symbol>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    const sym = symbolOf(ctx.checker, id);
    if (!sym || seenSym.has(sym)) continue;
    seenSym.add(sym);
    const overwritten = nextWriteTo(ctx.checker, sym, container, id);
    // `every` keeps the references a READ cannot claim — inside a closure
    // nothing visibly invokes — because a `.error` WRITE in such a closure
    // may still run, and execution the gate cannot see is assumed for a
    // write and refused for a read: both are the false-red direction.
    const every = usesOf(ctx.checker, sym, container).filter((u) => u.pos > id.pos);
    const uses = every.filter((u) => readsInWindow(u, id, overwritten, container, ctx.checker));
    members.push({ id, uses, every });
    for (const u of uses) {
      const d = u.parent;
      if (ts.isVariableDeclaration(d) && d.initializer === u && ts.isIdentifier(d.name)) queue.push(d.name);
    }
  }
  const allUses = members.flatMap((m) => m.uses);
  // A `.error` write inside a closure executes whenever the closure is
  // called, so it closes the window from the closure's creation (or from
  // the binding, for a hoisted declaration) — the same rule as a write to
  // the binding itself.
  const errorWrittenAt = Math.min(...members.flatMap((m) => m.every).map((u) => {
    const a = errorAccess(u);
    return a && isErrorWrite(a) ? executesAt({ pos: u.pos, node: u }, container, nameNode) : Infinity;
  }));
  const uses = allUses.filter((u) => u.pos < errorWrittenAt && (errorWrittenAt === Infinity || closureOf(u, container) === null));
  const via = (u: ts.Identifier) => u.text === name ? "" : ` (through alias \`${u.text}\`)`;

  const read = uses.find((u) => { const a = errorAccess(u); return a !== null && !isErrorWrite(a) && consumes(ctx, a); });
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
    if (isErrorWrite(p as ts.Expression)) return [site(ctx, p, "DISCARDED", "`.error` written on the awaited envelope, never read")];
    // The error VALUE is what is read here, so what HOLDS it decides
    // (adversarial review on PR #92, which showed the first version blessing
    // every read): a bare `(await q).error;` statement is a no-op, and a
    // local it is bound to must be read afterwards, exactly as a destructured
    // `error` must — `const e = (await q).error; return data;` is `const {
    // error } = await q; return data;` with more parentheses.
    // Walk up through what FORWARDS the value — `(e)`, `e as T`, `e!`,
    // `e satisfies T`, `await e`, the right side of a comma — to what holds
    // it. A holder that DISCARDS it is the no-op wearing another shape: an
    // expression statement, `void e`, the left side of a comma. `return void
    // (await q).error` is Codex's case on PR #92, and unlike a bare
    // statement it leaves nothing a linter would flag.
    // The same `consumes` the bound local and the envelope go through — a
    // discard position, a copy nothing reads, and (Codex on PR #92, round
    // fourteen) a literal nothing consumes: `const box = { cause: (await
    // q).error }; void box;` was OK because only a direct binding was
    // followed. The reason names which of the three it was.
    const holder = forwardedTo(p);
    if (discardedAt(holder)) {
      return [site(ctx, p, "DISCARDED", "`.error` read off the awaited envelope and dropped — nothing consumes the value")];
    }
    const bound = aliasTarget(holder);
    if (bound && !isReadAfter(ctx, bound)) {
      return [site(ctx, p, "DISCARDED", `\`.error\` bound as \`${bound.text}\` and never read in this function`)];
    }
    if (!consumes(ctx, p)) {
      return [site(ctx, p, "DISCARDED", "`.error` read off the awaited envelope into a literal nothing consumes")];
    }
    return [site(ctx, p, "OK", "`.error` read directly off the awaited envelope")];
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
 * A builder GROWS by assignment to itself (`q = q.eq(…)`, `q = c ? q.is(…) :
 * q.eq(…)`) and that classifies nothing; an `await`, `return` or arrow body
 * consumes it. A write whose right side does not root at `q` REPLACES it
 * (`q = other`, `({ q } = other)`, `for (q of xs)`, `var q = other`), and
 * from there every reference belongs to the replacement — the follow ends
 * (Codex on PR #92: `q = replacement; await q` was OK for a builder that
 * never ran, because assignment targets were skipped and the later await was
 * read as the original's). A builder replaced before anything consumed it
 * never runs, which is UNCLASSIFIED with a sentence saying so, as is one
 * continued on one branch of a conditional and replaced on the other; a
 * builder nothing consumes at all is UNCLASSIFIED, not OK.
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
    // uses here: look at every reference, reads and writes alike — a `var`
    // re-declaration included, since that is a write to the same binding.
    const refs: ts.Identifier[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && n !== nameNode && symbolOf(ctx.checker, n) === sym &&
        (!isDeclarationName(n) || (ts.isVariableDeclaration(n.parent) && n.parent.name === n))) {
        refs.push(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(container);
    refs.sort((a, b) => a.pos - b.pos);
    const written = new Set<number>(writesTo(ctx.checker, sym, container).map((w) => w.pos));
    // Past this position `q` holds something else.
    let replacedAt = Infinity;
    for (const use of refs) {
      if (use.pos <= nameNode.pos) continue;
      if (use.pos >= replacedAt) break;
      if (written.has(use.pos)) {
        const w = writeOf(use);
        const growth = continuesBuilder(ctx, w.rhs, sym);
        if (growth === "all") continue;
        replacedAt = w.end;
        if (growth === "some") {
          out.push(site(ctx, w.node, "UNCLASSIFIED",
            `builder \`${name}\` (line ${lineOf(ctx.sf, declaration)}) is continued on one branch and replaced on another — whether the query runs is not visible`));
          continue;
        }
        // The right side may still hand the builder somewhere (`q = wrap(q)`):
        // that reference classifies itself below. A replacement that never
        // mentions it, with nothing having consumed it, means it never ran.
        const mentioned = refs.some((r) => r.pos > use.pos && r.pos < replacedAt);
        if (!mentioned && out.length === 0) {
          out.push(site(ctx, w.node, "UNCLASSIFIED",
            `builder \`${name}\` (line ${lineOf(ctx.sf, declaration)}) is replaced before it is awaited, returned or passed on — the query never runs`));
        }
        continue;
      }
      const chain = outermost(use);
      const { top } = chain;
      if (chain.thenable) { out.push(site(ctx, top, "UNCLASSIFIED", `builder \`${name}\` consumed via .${chain.thenable}()`)); continue; }
      if (chain.uncalled) { out.push(site(ctx, top, "UNCLASSIFIED", uncalledReason(`builder \`${name}\``, chain.uncalled))); continue; }
      const p = top.parent;
      // The root of a growth assignment's right side: `q = q.eq(…)`.
      if (ts.isBinaryExpression(p) && p.right === top && ts.isIdentifier(p.left) && symbolOf(ctx.checker, p.left) === sym) continue;
      if (chain.rejects) { out.push(site(ctx, top, "UNCLASSIFIED", `builder \`${name}\` ${REJECTS_REASON}`)); continue; }
      out.push(...classifyTop(ctx, top, `builder \`${name}\` (line ${lineOf(ctx.sf, declaration)}) `));
    }
  }
  if (out.length === 0) {
    out.push(site(ctx, declaration, "UNCLASSIFIED", `builder \`${name}\` is never awaited, returned or passed on in this function`));
  }
  return out;
}

/**
 * The write a target identifier belongs to: the assignment, `var`
 * re-declaration or loop that writes it, with its right side (the value the
 * binding takes) and where that value's text ends — references before that
 * point are still about the old value (`q = wrap(q)`).
 */
function writeOf(target: ts.Identifier): { node: ts.Node; rhs: ts.Expression | undefined; end: number } {
  let n: ts.Node = target;
  for (;;) {
    const p: ts.Node = n.parent;
    if (!p || ts.isSourceFile(p)) return { node: target, rhs: undefined, end: target.end };
    if (ts.isBinaryExpression(p) && isAssignmentKind(p.operatorToken.kind) && p.left === n) return { node: p, rhs: p.right, end: p.end };
    if (ts.isVariableDeclaration(p) && p.name === n) {
      const stmt = p.parent.parent;
      if (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt)) return { node: stmt, rhs: stmt.expression, end: stmt.expression.end };
      return { node: p, rhs: p.initializer, end: p.end };
    }
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n) return { node: p, rhs: p.expression, end: p.expression.end };
    n = p;
  }
}

/** The branches a value can take: through wrappers and a conditional's two arms. */
function leaves(e: ts.Expression): ts.Expression[] {
  let n: ts.Expression = e;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
  if (ts.isConditionalExpression(n)) return [...leaves(n.whenTrue), ...leaves(n.whenFalse)];
  return [n];
}

/** The identifier a member/call chain grows from: `q` in `q.eq(1).is(2)`. */
function chainRoot(e: ts.Node): ts.Node {
  let n: ts.Node = e;
  for (;;) {
    if (ts.isCallExpression(n)) { n = n.expression; continue; }
    const m = memberAccess(n);
    if (m) { n = m.receiver; continue; }
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) { n = n.expression; continue; }
    return n;
  }
}

/**
 * Does a write's right side continue the builder — every branch a chain
 * rooted at the builder itself ("all"), none of them ("none"), or some?
 */
function continuesBuilder(ctx: Ctx, rhs: ts.Expression | undefined, sym: ts.Symbol): "all" | "some" | "none" {
  if (!rhs) return "none";
  const branches = leaves(rhs);
  const own = branches.filter((b) => { const r = chainRoot(b); return ts.isIdentifier(r) && symbolOf(ctx.checker, r) === sym; }).length;
  return own === branches.length ? "all" : own === 0 ? "none" : "some";
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

const CLIENT_TYPE = /SupabaseClient|adminClient|createClient/;

/**
 * What a type annotation says about a receiver. A client by name; a VALUE
 * only on positive evidence — a name (`PushKeys`), a shape (`{ auth: string
 * }`), a primitive, an array, a tuple, a literal; and nothing at all for a
 * type that says nothing (`any`, `unknown`, `object`, `{}`) or that the gate
 * would have to evaluate to read (`Deps["db"]`, `typeof x`, a conditional or
 * mapped type).
 */
function declaredByType(ctx: Ctx, t: ts.TypeNode | undefined): Declared {
  if (!t) return "unknown";
  let node: ts.TypeNode = t;
  if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
    const sym = ctx.checker.getSymbolAtLocation(t.typeName);
    const alias = sym?.declarations?.find(ts.isTypeAliasDeclaration);
    if (alias) node = alias.type;
  }
  if (CLIENT_TYPE.test(node.getText())) return "client";
  if (ts.isParenthesizedTypeNode(node)) return declaredByType(ctx, node.type);
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    const parts = node.types.map((m) => declaredByType(ctx, m));
    return parts.includes("client") ? "client" : parts.every((d) => d === "value") ? "value" : "unknown";
  }
  if (ts.isTypeReferenceNode(node) || ts.isArrayTypeNode(node) || ts.isTupleTypeNode(node) || ts.isLiteralTypeNode(node)) return "value";
  if (ts.isTypeLiteralNode(node)) return node.members.length === 0 ? "unknown" : "value";
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
    case ts.SyntaxKind.NumberKeyword:
    case ts.SyntaxKind.BooleanKeyword:
    case ts.SyntaxKind.BigIntKeyword:
    case ts.SyntaxKind.SymbolKeyword:
    case ts.SyntaxKind.NeverKeyword:
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.NullKeyword:
      return "value";
    default:
      return "unknown";
  }
}

/**
 * Is this receiver a supabase client, by how its BINDING is declared? The
 * checker resolves the identifier to its symbol, so an earlier same-named
 * declaration in a nested block is not consulted (Codex on PR #92).
 *
 * Three answers, and "value" needs POSITIVE evidence. The first version
 * answered "value" for anything that was not visibly a client, which made
 * the `.auth` rule fail OPEN — no site, no red — for an untyped parameter,
 * `const db = deps.db`, `const db = makeClient()`, `db: any`, and an untyped
 * alias of a real client (`const authDb = db`: Codex on PR #92, after the
 * adversarial review had named the class). Now:
 *   client   a factory call, inline or awaited; a variable initialised from
 *            one (at declaration or by a later assignment); an alias of a
 *            client, transitively, through casts; a parameter or variable
 *            TYPED as one, one type alias deep.
 *   value    a type annotation that is positive evidence (`declaredByType`);
 *            a literal initialiser; an alias of a value — every source the
 *            gate can read must be one.
 *   unknown  everything else: an untyped parameter, an initialiser the gate
 *            cannot read (a property, a call that is not a known factory, a
 *            conditional), a destructured binding with no readable client
 *            type, an import, a class member, a cycle of aliases.
 */
function declaredAsClient(ctx: Ctx, recv: ts.Expression, seen = new Set<ts.Symbol>()): Declared {
  const byExpression = (e: ts.Expression | undefined): Declared => {
    if (!e) return "unknown";
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
      const d = declaredByType(ctx, e.type);
      return d === "unknown" ? byExpression(e.expression) : d;
    }
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e)) return byExpression(e.expression);
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && CLIENT_FACTORIES.has(e.expression.text)) return "client";
    if (ts.isIdentifier(e)) return declaredAsClient(ctx, e, seen);
    if (ts.isLiteralExpression(e) || ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e) ||
      ts.isTemplateExpression(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword ||
      e.kind === ts.SyntaxKind.NullKeyword) return "value";
    return "unknown";
  };
  // Inline: `adminClient().auth`, `(db as any).auth`, `keysOf().auth`, `this.db.auth`.
  if (!ts.isIdentifier(recv)) return byExpression(recv);
  const sym = symbolOf(ctx.checker, recv);
  if (!sym || seen.has(sym)) return "unknown";
  seen.add(sym);
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!decl) return "unknown";
  if (ts.isVariableDeclaration(decl) || ts.isParameter(decl)) {
    // Every SOURCE of the binding: its initialiser (a parameter's default
    // included) and, for a variable, each later `db = …`. A factory anywhere
    // WINS, even under an annotation naming something else — `const db: Db =
    // adminClient()` is a client whatever `Db` is called (Codex on PR #92:
    // the first version let a value-typed annotation return before the
    // initialiser was looked at). With no visible client the annotation
    // decides; with no annotation, a value only when every source the gate
    // can read is one.
    const sources: Declared[] = decl.initializer ? [byExpression(decl.initializer)] : [];
    if (ts.isVariableDeclaration(decl)) {
      const visit = (n: ts.Node) => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) &&
          symbolOf(ctx.checker, n.left) === sym) sources.push(byExpression(n.right));
        ts.forEachChild(n, visit);
      };
      visit(ctx.sf);
    }
    if (sources.includes("client")) return "client";
    const byType = declaredByType(ctx, decl.type);
    if (byType !== "unknown") return byType;
    return sources.length > 0 && sources.every((d) => d === "value") ? "value" : "unknown";
  }
  if (ts.isBindingElement(decl)) {
    // `({ db }: Deps)` — the client is somewhere inside a type the gate
    // cannot read; refuse loudly rather than guess either way.
    let p: ts.Node = decl;
    while (ts.isBindingElement(p) || ts.isObjectBindingPattern(p) || ts.isArrayBindingPattern(p)) p = p.parent;
    const t = ts.isParameter(p) || ts.isVariableDeclaration(p) ? p.type : undefined;
    return declaredByType(ctx, t) === "client" ? "client" : "unknown";
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
    const chain = outermost(root);
    if (chain.thenable) { sites.push(site(ctx, chain.top, "UNCLASSIFIED", `query consumed via .${chain.thenable}()`)); return; }
    if (chain.uncalled) { sites.push(site(ctx, chain.top, "UNCLASSIFIED", uncalledReason("query", chain.uncalled))); return; }
    if (chain.rejects) { sites.push(site(ctx, chain.top, "UNCLASSIFIED", `query ${REJECTS_REASON}`)); return; }
    sites.push(...classifyTop(ctx, chain.top));
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
        // word is not enough: the receiver must be DECLARED as a client, or
        // declared as a value on positive evidence. A GoTrue call is always
        // a CALL, so on a receiver that is neither, a chain that reaches one
        // is UNCLASSIFIED — loud, never skipped (adversarial review and
        // Codex on PR #92) — while a bare read (`payload.auth?.token`) is a
        // field read whatever the receiver is.
        const ctx: Ctx = { sf, checker, file, queryLine: lineOf(sf, auth.token), followed };
        const declared = declaredAsClient(ctx, auth.receiver);
        if (declared === "client") seen(n, auth.receiver, auth.token);
        else if (declared === "unknown" && chainIsCalled(n)) {
          sites.push(site(ctx, n, "UNCLASSIFIED",
            `\`.auth.<member>(…)\` on \`${auth.receiver.getText(sf)}\`, which is declared as neither a client nor a value`));
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
    expect(s.reason).toMatch(/declared as neither a client nor a value/);
  });

  it("`.auth` receivers: a value needs POSITIVE evidence, and an alias of a client is a client (Codex, PR #92)", () => {
    // Codex's exact case: an untyped alias of a real client was a "value",
    // so the chain produced no site and the discarded error passed silently.
    expect(one(`async function f(token: string) {
  const db = adminClient();
  const authDb = db;
  const { data } = await authDb.auth.getUser(token);
  return data;
}`).verdict).toBe("DISCARDED");
    // Two hops, through casts, and a later assignment from an alias.
    expect(one(`async function f(token: string) {
  const db = adminClient();
  const a = db as unknown;
  const b = a;
  let c;
  c = b;
  const { data } = await (c as any).auth.getUser(token);
  return data;
}`).verdict).toBe("DISCARDED");
    // Receivers nobody TYPED, on a GoTrue-shaped call, are refused rather
    // than guessed — the review's finding, one shape at a time: a property,
    // a call that is not a known factory (awaited or not), an untyped
    // parameter, an `any`, an indexed-access type.
    const loud = classifySource(`declare function makeClient(): any;
async function a(deps: any) { const db = deps.db; const { data } = await db.auth.getUser("t"); return data; }
async function b() { const db = makeClient(); const { data } = await db.auth.getUser("t"); return data; }
async function c() { const db = await makeClient(); const { data } = await db.auth.getUser("t"); return data; }
async function d(db, t) { const { data } = await db.auth.getUser(t); return data; }
async function e(db: any) { const { data } = await db.auth.getUser("t"); return data; }
interface Deps { db: unknown }
async function g(db: Deps["db"]) { const { data } = await (db as any).auth.getUser("t"); return data; }`, "f.ts");
    expect(loud.map((s) => s.verdict)).toEqual(Array(6).fill("UNCLASSIFIED"));
    for (const s of loud) expect(s.reason).toMatch(/declared as neither a client nor a value/);
    // Positive evidence — a named type, a shape, a literal, an alias of one —
    // makes a call on the `auth` field a healthy read; a bare read is healthy
    // on ANY receiver.
    expect(classifySource(`interface PushKeys { auth: string }
function k(keys: PushKeys) { return keys.auth.replace("=", ""); }
function r(cfg: { auth: { admin: boolean } }) { return cfg.auth.admin; }
function q(payload) { return payload.auth?.token; }
function l() { const keys = { auth: "abc" }; const copy = keys; return copy.auth.slice(1); }
function u(keys: { auth: string } | null) { return keys?.auth.trim(); }`, "f.ts")).toEqual([]);
    // The stated false red: an UNTYPED receiver whose `auth` field is called.
    // Loud, and typing the receiver is the remedy.
    expect(one(`function m(keys) { return keys.auth.replace("=", ""); }`).verdict).toBe("UNCLASSIFIED");
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
    // Declared outside, read inside a block that does NOT redeclare it — a
    // bare block, because a read inside `if (c) { … }` is a read the failure
    // path may skip and is refused on purpose (round thirteen, below).
    expect(one(`async function f(db: any) {
  const r = await db.from("a").select("id").maybeSingle();
  { if (r.error) throw r.error; }
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

  it("a chain carrying .throwOnError() is REFUSED: it rejects with a raw PostgrestError nothing decides", () => {
    // postgrest-js rejects on failure here, so there is no envelope — and no
    // `HttpError` either: the rejection lands in `handleRequest`'s catch as
    // "unhandled error" with no context, the H14 shape, one step around the
    // CI check on `HttpError(5xx, …)` arity. The first version of this gate
    // blessed it; the adversarial review on PR #92 showed why that is wrong.
    const sites = classifySource(`async function f(db: any) {
  await db.from("a").update({ x: 1 }).eq("id", "k").throwOnError();
  let q = db.from("b").select("id");
  q = q.eq("id", "k");
  const { data } = await q.throwOnError();
  return data;
}`, "f.ts");
    expect(sites.map((s) => s.verdict)).toEqual(["UNCLASSIFIED", "UNCLASSIFIED"]);
    for (const s of sites) expect(s.reason).toMatch(/`\.throwOnError\(\)`, which rejects with a raw PostgrestError/);
  });

  it("a builder method referenced and never called runs nothing (Codex, PR #92)", () => {
    // `await db.from("walks").delete().throwOnError;` awaits a function value:
    // the delete never executes, TypeScript accepts it, and the first version
    // read the bare name as a throwing chain and said OK.
    const s = one(`async function f(db: any) { await db.from("walks").delete().throwOnError; }`);
    expect(s.verdict).toBe("UNCLASSIFIED");
    expect(s.reason).toMatch(/`\.throwOnError` is referenced and never called — nothing runs/);
    expect(one(`async function f(db: any) { const rows = await db.from("walks").select; return rows; }`).reason)
      .toMatch(/query: `\.select` is referenced and never called/);
    const viaBuilder = classifySource(`async function f(db: any) { let q = db.from("b").select("id"); const fn = q.eq; return fn; }`, "f.ts");
    expect(viaBuilder.map((s) => s.reason)).toEqual([expect.stringMatching(/builder `q`: `\.eq` is referenced and never called/)]);
  });

  it("a read inside a closure runs after any later write (Codex, PR #92)", () => {
    // Codex's exact case: the closure's reference sits BEFORE the overwrite
    // in the source and executes after it, and a position-only window
    // counted it as an earlier read.
    expect(one(`async function f(db: any) {
  let { data, error } = await db.from("x").select("id");
  const check = () => error;
  error = null;
  if (check()) throw check();
  return data;
}`).verdict).toBe("DISCARDED");
    // The envelope form, and a `.error` write inside a closure that a later
    // straight-line read may observe.
    expect(one(`async function g(db: any, other: any) {
  let r = await db.from("x").select("id");
  const check = () => r.error;
  r = other;
  if (check()) throw check();
  return r.data;
}`).verdict).toBe("DISCARDED");
    expect(one(`async function h(db: any) {
  const r = await db.from("x").select("id");
  const clear = () => { r.error = null; };
  if (r.error) throw r.error;
  return r.data;
}`).verdict).toBe("DISCARDED");
    // A write inside a HOISTED declaration can run before any read.
    expect(one(`async function k(db: any) {
  let { data, error } = await db.from("x").select("id");
  clear();
  if (error) throw error;
  return data;
  function clear() { error = null; }
}`).verdict).toBe("DISCARDED");
    // Healthy: a closure read with no later write at all, and a
    // straight-line read before a closure that writes is created.
    expect(one(`async function m(db: any) {
  const { data, error } = await db.from("x").select("id");
  const check = () => error;
  if (check()) throw check();
  return data;
}`).verdict).toBe("OK");
    expect(one(`async function n(db: any) {
  let { data, error } = await db.from("x").select("id");
  if (error) throw error;
  return { data, reset: () => { error = null; } };
}`).verdict).toBe("OK");
  });

  it("a closure that is never invoked reads nothing (Codex, PR #92)", () => {
    // Codex's exact case, one round after the closure's TIMING was fixed: no
    // later write, so the round-nine rule counted the closure's reference as
    // a read — and the closure is never called.
    expect(one(`async function f(db: any) {
  const { data, error } = await db.from("x").select("id");
  const check = () => error;
  return data;
}`).verdict).toBe("DISCARDED");
    expect(one(`async function g(db: any) {
  const r = await db.from("x").select("id");
  const check = () => r.error;
  return r.data;
}`).verdict).toBe("DISCARDED");
    // Execution the gate cannot see is no execution: a callback handed to a
    // call, a closure returned on an object, an inner closure never called.
    expect(one(`async function h(db: any, rows: number[]) {
  const { data, error } = await db.from("x").select("id");
  rows.forEach(() => { if (error) throw error; });
  return data;
}`).verdict).toBe("DISCARDED");
    expect(one(`async function k(db: any) {
  const { data, error } = await db.from("x").select("id");
  return { data, check: () => error };
}`).verdict).toBe("DISCARDED");
    expect(one(`async function m(db: any) {
  const { data, error } = await db.from("x").select("id");
  const outer = () => { const inner = () => error; return 1; };
  outer();
  return data;
}`).verdict).toBe("DISCARDED");
    // A call that never executes is no invocation: a reader called only from
    // another uninvoked closure (Codex, one round later), two closures that
    // only call each other, an IIFE inside an uninvoked closure.
    expect(one(`async function mn(db: any) {
  const { data, error } = await db.from("x").select("id");
  const check = () => error;
  const never = () => check();
  return data;
}`).verdict).toBe("DISCARDED");
    expect(one(`async function mc(db: any) {
  const { data, error } = await db.from("x").select("id");
  const a = () => b();
  const b = () => { a(); return error; };
  return data;
}`).verdict).toBe("DISCARDED");
    expect(one(`async function mi(db: any) {
  const { data, error } = await db.from("x").select("id");
  const never = () => { (() => error)(); };
  return data;
}`).verdict).toBe("DISCARDED");
    // A named closure MENTIONED is not a named closure CALLED: handed to a
    // call, it is the callback case with a name.
    expect(one(`async function mm(db: any, rows: number[]) {
  const { data, error } = await db.from("x").select("id");
  const check = () => { if (error) throw error; };
  rows.forEach(check);
  return data;
}`).verdict).toBe("DISCARDED");
    // Visibly invoked, at every level: a named closure that is called, an
    // IIFE, a hoisted declaration that is called, and a nested pair both
    // called. The closure's reference is the ONLY read in each, so the
    // healthy verdict rests on the invocation rule and not on a straight-line
    // read beside it (the first fixtures threw `error` itself, and a
    // sabotage of the IIFE rule stayed green).
    expect(one(`async function n(db: any) {
  const { data, error } = await db.from("x").select("id");
  const check = () => error;
  if (check()) throw check();
  return data;
}`).verdict).toBe("OK");
    expect(one(`async function o(db: any) {
  const { data, error } = await db.from("x").select("id");
  if ((() => error)()) throw new Error("failed");
  return data;
}`).verdict).toBe("OK");
    expect(one(`async function p(db: any) {
  const { data, error } = await db.from("x").select("id");
  if (failed()) throw new Error("failed");
  return data;
  function failed() { return error !== null; }
}`).verdict).toBe("OK");
    expect(one(`async function q(db: any) {
  const { data, error } = await db.from("x").select("id");
  const outer = () => { const inner = () => error; return inner(); };
  if (outer()) throw new Error("failed");
  return data;
}`).verdict).toBe("OK");
    // Invoked THROUGH an invoked closure, and a pair of closures that call
    // each other where the reader ALSO has one call from straight-line code
    // — the cycle must not recurse forever, and the straight-line call is
    // what counts. (A self-recursive reader — `i > 0 ? f(i - 1) : error` —
    // reads only on its base case, a branch, and is refused since round
    // thirteen; the cycle guard is exercised by the mutual case above.)
    expect(one(`async function r(db: any) {
  const { data, error } = await db.from("x").select("id");
  const check = () => error;
  const wrap = () => check();
  if (wrap()) throw new Error("failed");
  return data;
}`).verdict).toBe("OK");
    expect(one(`async function s(db: any, n: number) {
  const { data, error } = await db.from("x").select("id");
  const f = (i: number): unknown => { g(i); return error; };
  const g = (i: number): void => { if (i > 0) f(i - 1); };
  if (f(n)) throw new Error("failed");
  return data;
}`).verdict).toBe("OK");
  });

  it("a copy of the error is a read only if the copy is read (Codex, PR #92)", () => {
    // Round twelve: the discard positions were closed one round earlier, and
    // a COPY is the same discard with a name — `const copy = error` is an
    // initializer, so the reference was "consumed", and the copy was never
    // looked at. The value is followed to a real consumer, transitively and
    // under the copy's own window.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const copy = error; void copy; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); const copy = r.error; void copy; return r.data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const a = error; const b = a; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); let copy; copy = error; void copy; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const e = (await db.from("a").select("id")).error; const c = e; void c; return 1; }`).verdict).toBe("DISCARDED");
    // The copy's own window: overwritten before it is read, it carried nothing.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); let copy = error; copy = null; if (copy) throw copy; return data; }`).verdict).toBe("DISCARDED");
    // A copy that IS read, one hop or two, is the read.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const copy = error; if (copy) throw copy; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); const a = r.error; const b = a; if (b) throw b; return r.data; }`).verdict).toBe("OK");
  });

  it("a closure's call site counts only while the binding still holds it (Codex, PR #92)", () => {
    // Round twelve: a call resolved by SYMBOL alone was this closure's
    // wherever it sat, and `check = () => null` between the binding and the
    // call means the call runs the replacement. The call gets the window a
    // read gets: straight-line before the next write, inside a closure only
    // when no write can follow at all.
    expect(one(`async function f(db: any) {
  const { data, error } = await db.from("a").select("id");
  let check = () => error;
  check = () => null;
  if (check()) throw new Error("failed");
  return data;
}`).verdict).toBe("DISCARDED");
    expect(one(`async function g(db: any) {
  const r = await db.from("a").select("id");
  let check = () => r.error;
  check = () => null;
  if (check()) throw new Error("failed");
  return r.data;
}`).verdict).toBe("DISCARDED");
    // Through an invoked wrapper that runs after the replacement.
    expect(one(`async function h(db: any) {
  const { data, error } = await db.from("a").select("id");
  let check = () => error;
  const wrap = () => check();
  check = () => null;
  if (wrap()) throw new Error("failed");
  return data;
}`).verdict).toBe("DISCARDED");
    // A hoisted declaration is live from the top, so any write bounds it.
    expect(one(`async function i(db: any) {
  const { data, error } = await db.from("a").select("id");
  check = () => null;
  if (check()) throw new Error("failed");
  return data;
  function check(): unknown { return error; }
}`).verdict).toBe("DISCARDED");
    // The replacement inside a closure counts from that closure's creation.
    expect(one(`async function j(db: any) {
  const { data, error } = await db.from("a").select("id");
  let check = () => error;
  const reset = () => { check = () => null; };
  reset();
  if (check()) throw new Error("failed");
  return data;
}`).verdict).toBe("DISCARDED");
    // A call BEFORE the replacement is this closure's, arrow or hoisted.
    expect(one(`async function k(db: any) {
  const { data, error } = await db.from("a").select("id");
  let check = () => error;
  if (check()) throw new Error("failed");
  check = () => null;
  return data;
}`).verdict).toBe("OK");
    expect(one(`async function l(db: any) {
  const { data, error } = await db.from("a").select("id");
  if (check()) throw new Error("failed");
  check = () => null;
  return data;
  function check(): unknown { return error; }
}`).verdict).toBe("OK");
  });

  it("a logical assignment evaluates its right side conditionally, so it copies nothing (Codex, PR #92)", () => {
    // Round thirteen: `copy ??= error` runs the right side only when `copy`
    // is nullish, and the round-twelve alias rule followed it as a copy.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); let copy = new Error("other"); copy ??= error; throw copy; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); let copy: unknown = 1; copy ||= error; if (copy) throw copy; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); let copy: unknown; copy = error; if (copy) throw copy; return data; }`).verdict).toBe("OK");
  });

  it("an error stored in a literal is a read only if the literal is consumed (Codex, PR #92)", () => {
    // Round thirteen: `{ error }` is neither a discard position nor an
    // identifier copy, so the shorthand property counted as consumption while
    // the aggregate went nowhere. The literal is followed by the same rules.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const errs = [error]; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); const box = { e: r.error }; return r.data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; if (box.error) throw box.error; return data; }`).verdict).toBe("OK");
    expect(one(`declare function log(x: unknown): void;
async function f(db: any) { const { data, error } = await db.from("a").select("id"); log({ cause: error }); return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); if (error) throw { cause: error }; return data; }`).verdict).toBe("OK");
  });

  it("a read the failure path can skip is not a read (Codex, PR #92)", () => {
    // Round thirteen: supabase-js supplies `data: null` on failure, so a read
    // gated on the data — or on anything — runs exactly when there is no
    // error to read. Inside a branch that excludes the binding, or after a
    // conditional return, the reference establishes nothing.
    expect(one(`declare const console: { error(x: unknown): void };
async function f(db: any) { const { data, error } = await db.from("a").select("id"); if (data) console.error(error); return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); if (!data) return null; if (error) throw error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, rows: number[]) { const { data, error } = await db.from("a").select("id"); for (const r of rows) { if (error) throw error; } return data; }`).verdict).toBe("DISCARDED");
    expect(one(`declare const log: { error(x: unknown): void } | undefined;
async function f(db: any) { const { data, error } = await db.from("a").select("id"); log?.error(error); return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const e = data ? error : null; if (e) throw e; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`declare function log(x: unknown): void;
async function f(db: any) { const { data, error } = await db.from("a").select("id"); data && log(error); return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); if (r.data) { if (r.error) throw r.error; } return r.data; }`).verdict).toBe("DISCARDED");
    expect(one(`declare function other(): Promise<void>;
async function f(db: any) { const { data, error } = await db.from("a").select("id"); try { await other(); } catch { if (error) throw error; } return data; }`).verdict).toBe("DISCARDED");
    // Inside a closure, and at the call site that would establish the closure.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const check = () => { if (data) return error; return null; }; if (check()) throw new Error("x"); return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const check = () => error; if (data && check()) throw new Error("x"); return data; }`).verdict).toBe("DISCARDED");
    // Stated as the conservative direction: the gate does not know `data` is
    // null on failure, so a guard that reads the error only on the right of
    // `&&` and then returns is refused even though it inspects the error on
    // the failure path. Write `if (error) throw error;` first.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); if (!data && !error) return null; if (error) throw error; return data; }`).verdict).toBe("DISCARDED");
    // Not exits, not branches: a conditional `throw` aborts rather than
    // completing as an absence; a `do` body runs at least once; a `break`
    // inside a `switch` leaves the switch; a `try` body always runs.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); if (!data) throw new Error("not found"); if (error) throw error; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); do { if (error) throw error; } while (false); return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any, k: number) { const { data, error } = await db.from("a").select("id"); let y = 0; switch (k) { case 1: y = 1; break; } if (error) throw error; return data + y; }`).verdict).toBe("OK");
    expect(one(`declare function other(): Promise<void>;
async function f(db: any) { const { data, error } = await db.from("a").select("id"); try { await other(); } catch (e) { throw e; } if (error) throw error; return data; }`).verdict).toBe("OK");
    // The binding inside the same branch as its read is not a branch relative to it.
    expect(one(`async function f(db: any, c: boolean) { if (c) { const { data, error } = await db.from("a").select("id"); if (error) throw error; return data; } return null; }`).verdict).toBe("OK");
  });

  it("a default initializer runs only when its value is undefined, so a read there establishes nothing (Codex, PR #92)", () => {
    // Round fourteen: `function check(x = error)` skips its initializer when
    // the call supplies an argument, and the branch rule did not know a
    // default as a branch. A parameter's, a binding element's and a
    // destructuring assignment's default are all branch edges now.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); if (check(null)) throw new Error("x"); return data; function check(x: unknown = error) { return x; } }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const check = (x: unknown = error) => x; if (check()) throw new Error("x"); return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); const check = (x: unknown = r.error) => x; if (check()) throw new Error("x"); return r.data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, obj: { e?: unknown }) { const { data, error } = await db.from("a").select("id"); const { e = error } = obj; if (e) throw e; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, obj: { e?: unknown }) { const { data, error } = await db.from("a").select("id"); let e: unknown; ({ e = error } = obj); if (e) throw e; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, arr: unknown[]) { const { data, error } = await db.from("a").select("id"); let e: unknown; [e = error] = arr; if (e) throw e; return data; }`).verdict).toBe("DISCARDED");
    // A read in the BODY of a function with a defaulted parameter is a read.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); function check(x: number = 1) { return error; } if (check()) throw new Error("x"); return data; }`).verdict).toBe("OK");
  });

  it("a direct `.error` read stored in a literal is a read only if the literal is consumed (Codex, PR #92)", () => {
    // Round fourteen: the direct read followed a local binding and nothing
    // else, so `{ cause: (await q).error }` bound to a local nothing reads
    // was OK. It goes through `consumes` now, like the bound local and the
    // envelope.
    expect(one(`async function f(db: any) { const box = { cause: (await db.from("a").select("id")).error }; void box; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const errs = [(await db.from("a").select("id")).error]; return 1; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const box = { cause: (await db.from("a").select("id")).error }; if (box.cause) throw box.cause; }`).verdict).toBe("OK");
    expect(one(`declare function log(x: unknown): void;
async function f(db: any) { log({ cause: (await db.from("a").select("id")).error }); }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { throw { cause: (await db.from("a").select("id")).error }; }`).verdict).toBe("OK");
  });

  it("a class field initializer is deferred execution and reads nothing (Codex, PR #92)", () => {
    // Round fifteen: a class body is not function-like, so `closuresAround`
    // saw straight-line code in `class Never { field = error }` — an
    // initializer that runs per construction, and `Never` is never built.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); class Never { field = error; } return data; }`).verdict).toBe("DISCARDED");
    // Refused even when constructed: the value lands on an instance the gate
    // does not follow. A static field is a store it does not follow either.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const C = class { f = error; }; new C(); return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); class X { static f = error; } return data; }`).verdict).toBe("DISCARDED");
    // A static block runs when the class statement does.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); class X { static { if (error) throw error; } } return data; }`).verdict).toBe("OK");
  });

  it("a literal is read only through the member that carries the error (Codex, PR #92)", () => {
    // Round fifteen: following the literal bound it to `box`, and any use of
    // `box` then counted — `return box.data` included. The key the error sits
    // under travels with the value now: a member read counts only along that
    // path, a destructuring only through that element (a rest carries it
    // on), and a value that merely CARRIES the error is read only when
    // handed on whole — a call, a return, a throw — not when its truthiness
    // is what the consumer wants.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { error, data }; return box.data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { error, data }; const { data: d } = box; return d; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; if (box) return data; return null; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { meta: { error, ok: true } }; if (box.meta.ok) return data; return null; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const errs = [error]; if (errs.length) return null; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const errs = [error]; const outer = [...errs]; if (outer[0]) throw outer[0]; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, k: string) { const { data, error } = await db.from("a").select("id"); const box = { error, data }; if (box[k]) throw box[k]; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); const box = { e: r.error, d: r.data }; return box.d; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const box = { e: (await db.from("a").select("id")).error, ok: true }; return box.ok; }`).verdict).toBe("DISCARDED");
    // Along the path, one hop or two, by member or by pattern, an object
    // spread carrying the keys through, a numeric index, and handed on whole.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { error, data }; if (box.error) throw box.error; return box.data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { cause: error }; const { cause } = box; if (cause) throw cause; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { meta: { error } }; if (box.meta.error) throw box.meta.error; return data; }`).verdict).toBe("OK");
    expect(one(`declare function log(x: unknown): void;
async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { meta: { error } }; log(box.meta); return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const errs = [null, error]; if (errs[1]) throw errs[1]; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; const outer = { ...box }; if (outer.error) throw outer.error; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { error, data }; const { data: d, ...rest } = box; if (rest.error) throw rest.error; return d; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { error, data }; return box; }`).verdict).toBe("OK");
  });

  it("spreading the error scatters its keys; a member read of that literal reads nothing (Codex, PR #92)", () => {
    // Round sixteen: `{ ...error }` copies the ERROR's own fields under names
    // the gate cannot enumerate, and round fifteen passed the path through
    // unchanged — which left `box` holding the error at the empty path, so
    // any member of it counted. The keys are UNKNOWN now, so only handing
    // the literal on whole reads it. A spread of a CARRIER is unchanged:
    // there the operand's keys, the error's among them, do pass through.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { ...error, data }; return box.data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { ...error }; if (box.message) return null; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { ...error, data }; const { message } = box; if (message) return null; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { ...error, data }; throw box; }`).verdict).toBe("OK");
    expect(one(`declare function log(x: unknown): void;
async function f(db: any) { const { data, error } = await db.from("a").select("id"); log({ ...error }); return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const outer = { error, data }; const box = { ...outer }; if (box.error) throw box.error; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const outer = { error, data }; const box = { ...outer }; return box.data; }`).verdict).toBe("DISCARDED");
  });

  it("a member of the error must itself be consumed (Codex, PR #92)", () => {
    // Round sixteen: reaching the error is not reading it. `void
    // error?.message` names a field and throws the answer away, and the
    // member branch returned OK the moment the access existed — the
    // round-seven discard positions, one hop in. The access is followed by
    // the same rules now, for a bound local, an envelope variable and a
    // direct read alike.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); void error?.message; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); void r.error?.message; return r.data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { void (await db.from("a").select("id")).error?.message; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); error?.message; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const m = error?.message; void m; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, k: string) { const { data, error } = await db.from("a").select("id"); void error?.[k]; return data; }`).verdict).toBe("DISCARDED");
    // Consumed, one hop in: a condition, a copy that is read, an argument,
    // and a comparison on an envelope's own member.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); if (error?.message) throw error; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const m = error?.message; if (m) throw new Error(m); return data; }`).verdict).toBe("OK");
    expect(one(`declare function log(x: unknown): void;
async function f(db: any) { const { data, error } = await db.from("a").select("id"); log(error?.message); return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); if (r.error.code === "PGRST116") return null; return r.data; }`).verdict).toBe("OK");
  });

  it("taking the error apart is a read only of the piece that is read (own sibling check, PR #92)", () => {
    // The member hop's rule one function over, in `patternReads`: with the
    // path empty it answered "a read by construction", so `const { message }
    // = error; void message;` took the error apart and discarded every piece
    // while reporting OK. Found by checking the sibling of Codex's
    // round-sixteen finding rather than by the review.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const { message } = error; void message; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const { message } = error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const { ...rest } = error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); const { message } = r.error; void message; return r.data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const { code } = error; if (code) throw error; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const { ...rest } = error; throw rest; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const { details: { hint } } = error; if (hint) throw error; return data; }`).verdict).toBe("OK");
  });

  it("a carried key stops carrying the error once it is redefined (Codex, PR #92)", () => {
    // Round seventeen: the key travelled with the value and nothing asked
    // whether it survived. `{ ...carrier, error: fallback }` hands back the
    // fallback, so `box.error` can only ever observe THAT — measured OK on
    // the shipped gate, with a later computed key and a later spread beside
    // it. The same one statement on: `box.error = fallback` replaces the
    // member the path names, which is a write the read window did not close.
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const carrier = { error }; const box = { ...carrier, error: fallback }; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, k: string, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error, [k]: fallback }; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, extra: any) { const { data, error } = await db.from("a").select("id"); const box = { error, ...extra }; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; box.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { cause: error }; box.cause = fallback; if (box.cause) throw box.cause; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { cause: error }; delete box.cause; if (box.cause) throw box.cause; return data; }`).verdict).toBe("DISCARDED");
    // The carrier wins when it comes LAST; a write to another member, an
    // earlier sibling and an array's stable index all leave the path alone.
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const carrier = { error }; const box = { error: fallback, ...carrier }; if (box.error) throw box.error; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { cause: error, note: "x" }; box.note = fallback; if (box.cause) throw box.cause; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { error, data }; if (box.error) throw box.error; return box.data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any, more: any[]) { const { data, error } = await db.from("a").select("id"); const errs = [error, ...more]; if (errs[0]) throw errs[0]; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; if (box.error) throw box.error; box.error = fallback; return data; }`).verdict).toBe("OK");
  });

  it("a write that replaces the carried member is found through any name for the object (Codex, PR #92)", () => {
    // Round eighteen, three ways the round-seventeen write rule saw less than
    // it claimed: it compared `path[0]` only, so a write BELOW the head
    // (`box.nested.cause = fallback`) was missed; it required a plain
    // identifier receiver, so `(box).error = …` and `(box as any).error = …`
    // were invisible; and it computed the window per binding, so a write
    // through one name for the object left another name's window open.
    // A write replaces the error when its key chain is a PREFIX of the
    // carried path — deeper mutates a field of the error and leaves the error
    // itself, divergent touches another member.
    const nested = `const box = { nested: { cause: error } };`;
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); ${nested} box.nested.cause = fallback; if (box.nested.cause) throw box.nested.cause; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, other: any) { const { data, error } = await db.from("a").select("id"); ${nested} box.nested = other; if (box.nested.cause) throw box.nested.cause; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; const alias = box; box.error = fallback; if (alias.error) throw alias.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; const alias = box; alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; (box).error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; (box as any).error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, k: string, fallback: any) { const { data, error } = await db.from("a").select("id"); ${nested} box.nested[k] = fallback; if (box.nested.cause) throw box.nested.cause; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; (box.error) = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    // Deeper than the path, diverging from it, and another object entirely.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); ${nested} box.nested.cause.message = "x"; if (box.nested.cause) throw box.nested.cause; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any, x: any) { const { data, error } = await db.from("a").select("id"); ${nested} box.nested.other = x; if (box.nested.cause) throw box.nested.cause; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; const other = { error: 1 }; other.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); ${nested} if (box.nested.cause) throw box.nested.cause; return data; }`).verdict).toBe("OK");
  });

  it("a name is the same object only while it still comes from it (Codex, PR #92)", () => {
    // Round nineteen, both directions of one model. The alias GROUP was a set
    // of names with no sense of time or depth: `const inner = box.nested`
    // never joined it (a write through `inner` was missed), while `let alias =
    // box; alias = other;` never left it, so a write through the REPLACEMENT
    // closed the window on healthy code — a gate red on a healthy tree, the
    // worst shape there is. A name roots at what it was initialised from,
    // through member chains and transitively, and only while no write to it
    // has executed in between.
    const nested = `const box = { nested: { cause: error } };`;
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); ${nested} const inner = box.nested; inner.cause = fallback; if (box.nested.cause) throw box.nested.cause; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, other: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias = box; alias.error = fallback; alias = other; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    // Not the object any more, never the object, below the path, beside it.
    expect(one(`async function f(db: any, other: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias = box; alias = other; alias.error = null; if (box.error) throw box.error; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); ${nested} const inner = box.nested; if (inner.cause) throw inner.cause; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); ${nested} const inner = box.nested; inner.cause.message = "x"; if (box.nested.cause) throw box.nested.cause; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any, x: any) { const { data, error } = await db.from("a").select("id"); ${nested} const inner = box.nested; inner.other = x; if (box.nested.cause) throw box.nested.cause; return data; }`).verdict).toBe("OK");
  });

  it("a name takes its provenance from the last write, and a write target is not a read (Codex, PR #92)", () => {
    // Round twenty. The finding named provenance — `let alias: T; alias =
    // box;` establishes it as much as an initialiser does, so what a name
    // refers to is decided by the LAST write before the point in question,
    // and an assignment back restores it. But the case was passing for a
    // second reason the finding did not name: `alias.error = fallback` was
    // counted as a READ of the error, because a member on the carried path is
    // consumed by whatever holds it and nothing asked which SIDE of the
    // assignment it sat on. A target is written, not read.
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias: any; alias = box; alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { nested: { cause: error } }; let inner: any; inner = box.nested; inner.cause = fallback; if (box.nested.cause) throw box.nested.cause; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, other: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias = box; alias = other; alias = box; alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, other: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; let mid = box; const held = mid; mid = other; held.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; box.error = fallback; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; delete box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, other: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias = box; alias = other; alias.error = null; if (box.error) throw box.error; return data; }`).verdict).toBe("OK");
  });

  it("only a write that is certain to have run says what a name refers to (Codex, PR #92)", () => {
    // Round twenty-one. `(alias) = box` is the same assignment wearing the
    // wrappers `memberChain` already climbs on the other side — the per-site
    // disease again. And a write inside a closure was taken as definite
    // provenance, because `executesAt` puts such a write at the closure's
    // CREATION: right for "this may have happened by now", wrong for "this
    // decided what the name is", and it reported a genuine read DISCARDED.
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias: any; (alias) = box; alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias: any = { error: null }; const set = () => { alias = box; }; alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("OK");
    // Where the write COULD have moved the name away, the gate cannot say
    // whether the member write landed on the error, and refuses — the stated
    // conservative direction, a false red rather than a miss.
    expect(one(`async function f(db: any, other: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias = box; const set = () => { alias = other; }; alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, other: any, fallback: any, c: boolean) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias = box; if (c) { alias = other; } alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
  });

  it("a write that CANNOT run is ignored; one that MIGHT have run is unknown (Codex, PR #92)", () => {
    // Round twenty-two is round twenty-one's mirror: filtering the uncertain
    // writes out let the declaration answer as though the branch could never
    // be taken, so `let alias = other; if (c) alias = box; alias.error =
    // fallback;` read OK while a taken branch replaces the query error. The
    // two are only reconcilable by asking whether the write can run at all: a
    // closure the gate cannot see INVOKED cannot, so it neither gives
    // provenance nor takes it away; a branch — or an invoked closure — might,
    // which leaves the name unknown, and a write through an unknown name is
    // treated as possibly landing on the error rather than assumed away.
    expect(one(`async function f(db: any, other: any, fallback: any, c: boolean) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias = other; if (c) alias = box; alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias: any = { error: null }; const set = () => { alias = box; }; set(); alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias: any = { error: null }; const set = () => { alias = box; }; alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any, fallback: any) { const { data, error } = await db.from("a").select("id"); const box = { error }; const other = { error: 1 }; other.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("OK");
  });

  it("uncertainty ends at the next definite write, and an unknown name may hold the carrier at any depth (Codex, PR #92)", () => {
    // Round twenty-three, both halves of round twenty-two's own rule. An
    // uncertain write SUPERSEDED by a definite one decides nothing —
    // `if (c) alias = other; alias = other2;` ends certain, and calling it
    // unknown was a red on healthy code. And an unknown name was matched at
    // the bound object's depth only, so one that may hold the NESTED carrier
    // slipped past: `let inner = other; if (c) inner = box.nested;` writes
    // `inner.cause`, which is the error when the branch is taken.
    expect(one(`async function f(db: any, other: any, other2: any, fallback: any, c: boolean) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias = box; if (c) alias = other; alias = other2; alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any, other: any, fallback: any, c: boolean) { const { data, error } = await db.from("a").select("id"); const box = { nested: { cause: error } }; let inner = other; if (c) inner = box.nested; inner.cause = fallback; if (box.nested.cause) throw box.nested.cause; return data; }`).verdict).toBe("DISCARDED");
    // Uncertainty AFTER the last definite write still counts.
    expect(one(`async function f(db: any, other: any, other2: any, fallback: any, c: boolean) { const { data, error } = await db.from("a").select("id"); const box = { error }; let alias = box; alias = other2; if (c) alias = other; alias.error = fallback; if (box.error) throw box.error; return data; }`).verdict).toBe("DISCARDED");
  });

  it("a builder REPLACED before it is awaited never runs (Codex, PR #92)", () => {
    // Codex's exact case: assignment targets were skipped, so the later
    // `await q` was read as the original builder's consumer and the site
    // was OK — for a query that was never executed.
    const gone = classifySource(`async function f(db: any, replacement: any) {
  let q = db.from("abandoned").select("id");
  q = replacement;
  const { error } = await q;
  if (error) throw error;
}`, "fixture.ts");
    expect(gone.map((s) => s.verdict)).toEqual(["UNCLASSIFIED"]);
    expect(gone[0]?.line).toBe(3);
    expect(gone[0]?.reason).toMatch(/builder `q` \(line 2\) is replaced before it is awaited/);
    // Growth is not replacement: plainly, and through a conditional.
    expect(one(`async function g(db: any, c: boolean) {
  let q = db.from("x").select("id");
  q = q.eq("a", 1);
  q = c ? q.is("b", null) : q.eq("b", 2);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}`).verdict).toBe("OK");
    // A replacement AFTER the await belongs to the replacement: the earlier
    // query stays OK and the later `await q` is not attributed to it.
    expect(classifySource(`async function h(db: any, other: any) {
  let q = db.from("x").select("id");
  const { error } = await q;
  if (error) throw error;
  q = other;
  await q;
}`, "fixture.ts").map((s) => s.verdict)).toEqual(["OK"]);
    // Handed to a call inside its own replacement: the call is the consumer,
    // refused loudly rather than reported as abandoned.
    const wrapped = classifySource(`async function k(db: any, wrap: any) {
  let q = db.from("x").select("id");
  q = wrap(q);
  const { error } = await q;
  if (error) throw error;
}`, "fixture.ts");
    expect(wrapped.map((s) => s.verdict)).toEqual(["UNCLASSIFIED"]);
    expect(wrapped[0]?.reason).toMatch(/CallExpression/);
    // Pattern targets, a loop target and a `var` re-declaration are writes too.
    for (const write of ["({ q } = other);", "[q] = other;", "for (q of other) {}"]) {
      const s = one(`async function m(db: any, other: any) {
  let q = db.from("x").select("id");
  ${write}
  const { error } = await q;
  if (error) throw error;
}`);
      expect(s.verdict, write).toBe("UNCLASSIFIED");
      expect(s.reason, write).toMatch(/replaced before/);
    }
    const redeclared = one(`async function v(db: any, other: any) {
  var q = db.from("x").select("id");
  var q = other;
  const { error } = await q;
  if (error) throw error;
}`);
    expect(redeclared.verdict).toBe("UNCLASSIFIED");
    expect(redeclared.reason).toMatch(/replaced before/);
    // Continued on one branch and replaced on the other: not visible, so loud.
    const half = one(`async function n(db: any, c: boolean, other: any) {
  let q = db.from("x").select("id");
  q = c ? q.eq("a", 1) : other;
  const { error } = await q;
  if (error) throw error;
}`);
    expect(half.verdict).toBe("UNCLASSIFIED");
    expect(half.reason).toMatch(/one branch/);
  });

  it("a factory initialiser is a client whatever its annotation says (Codex, PR #92)", () => {
    // `const db: Db = adminClient()` — the annotation names a value, the
    // initialiser is visibly a client, and the first version returned on the
    // annotation before looking. Client evidence wins.
    expect(one(`interface Db { auth: unknown }
async function f(token: string) { const db: Db = adminClient(); const { data } = await db.auth.getUser(token); return data; }`).verdict).toBe("DISCARDED");
    expect(one(`interface Db { auth: unknown }
async function f(token: string, db: Db = adminClient()) { const { data } = await db.auth.getUser(token); return data; }`).verdict).toBe("DISCARDED");
    expect(one(`interface Db { auth: unknown }
async function f(token: string) { let db: Db; db = adminClient(); const { data } = await db.auth.getUser(token); return data; }`).verdict).toBe("DISCARDED");
    // With nothing visibly a client, the annotation still decides.
    expect(classifySource(`interface Keys { auth: string }
declare function load(): Keys;
function g(keys: Keys = load()) { return keys.auth.trim(); }`, "f.ts")).toEqual([]);
  });

  it("a direct `.error` read that `void` or a comma discards is a discard (Codex, PR #92)", () => {
    expect(one(`async function f(db: any) { return void (await db.from("a").select("id")).error; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const x = ((await db.from("a").select("id")).error, 1); return x; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { void ((await db.from("a").select("id")).error as unknown); }`).verdict).toBe("DISCARDED");
    // Forwarded, not discarded: the right side of a comma reaches the local.
    expect(one(`async function f(db: any) { const e = (0, (await db.from("a").select("id")).error); if (e) throw e; }`).verdict).toBe("OK");
  });

  it("a bound `error` or an envelope's `.error` mentioned in a discard position is not read (Codex, PR #92)", () => {
    // The direct-read fix closed `void (await q).error`; the same shapes
    // were still reads for a BOUND local and for an envelope variable,
    // because `isReadAfter` and the `.error`-read search counted any
    // reference. A reference nothing consumes is not a read of anything.
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); void error; return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const { data, error } = await db.from("a").select("id"); (error, 1); return data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); void r.error; return r.data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); r.error; return r.data; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { const e = (await db.from("a").select("id")).error; void e; return 1; }`).verdict).toBe("DISCARDED");
    // Consumed, whatever the surrounding expression's fate: `??`, a
    // condition, a call argument, an awaited or comma-forwarded value.
    expect(one(`declare function log(x: unknown): void;
async function f(db: any) { const { data, error } = await db.from("a").select("id"); void log(error); return data; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const r = await db.from("a").select("id"); const e = (0, r.error); if (e) throw e; return r.data; }`).verdict).toBe("OK");
  });

  it("`.error` read off the awaited envelope must still be USED (adversarial review on PR #92)", () => {
    // The first version blessed every direct read. `const e = (await
    // q).error; return data;` is the destructured discard with more
    // parentheses, and a bare `(await q).error;` is a statement that does
    // nothing; both go through the same rule a destructured `error` does.
    expect(one(`async function f(db: any) { const e = (await db.from("a").select("id")).error; return 1; }`).reason)
      .toMatch(/`\.error` bound as `e` and never read/);
    expect(one(`async function f(db: any) { (await db.from("a").select("id")).error; return 1; }`).reason)
      .toMatch(/read off the awaited envelope and dropped/);
    expect(one(`async function f(db: any) { let e = (await db.from("a").select("id")).error; e = null; if (e) throw e; }`).verdict).toBe("DISCARDED");
    expect(one(`async function f(db: any) { let e: unknown; e = (await db.from("a").select("id")).error; if (e) throw e; }`).verdict).toBe("OK");
    expect(one(`async function f(db: any) { const e = (await db.from("a").select("id")).error; if (e) throw e; }`).verdict).toBe("OK");
    expect(one(`declare function log(x: unknown): void;
async function f(db: any) { log((await db.from("a").select("id")).error); }`).verdict).toBe("OK");
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
