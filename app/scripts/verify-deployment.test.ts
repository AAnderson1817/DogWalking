import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Review M4: the production deploy asserted nothing, so a function that
 * deployed "successfully" and then failed to evaluate was indistinguishable
 * from a working one until an operator hit it at a client's door.
 *
 * `scripts/verify-deployment.sh` is that assertion. This drives it against a
 * stub that can be broken in each direction, because a verification script is
 * exactly the kind of code that passes for the wrong reason — this repository
 * has shipped a typecheck that checked zero files, a vault verification that
 * verified nothing and a deploy that could skip its own function job. Every
 * case below therefore breaks ONE thing and requires the script to notice.
 */

const REPO = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO, "scripts", "verify-deployment.sh");
const REF = "stubproject";

type Handler = (name: string) => { status: number; body: string; requestId?: boolean };

/** What a healthy project answers: 405 + our envelope everywhere except the
 * two functions with their own contract. Mirrors `contract_for` in the script
 * — deliberately re-stated here rather than imported, so a change to one has
 * to be a change to both. */
const healthy: Handler = (name) => {
  if (name === "stripe-webhook") return { status: 405, body: "POST only" };
  if (name === "platform-webhook") return { status: 405, body: "POST only" };
  if (name === "unsubscribe") {
    return { status: 200, body: "<h1>You're unsubscribed</h1>" };
  }
  return {
    status: 405,
    body: JSON.stringify({ ok: false, error: { code: "method_not_allowed", message: "POST only" } }),
    requestId: true,
  };
};

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function stub(opts: {
  /** slugs the project reports as deployed; defaults to the repo's own set */
  inventory?: { slug: string; status: string }[];
  inventoryStatus?: number;
  fn?: Handler;
}): Promise<string> {
  const handler = opts.fn ?? healthy;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === `/v1/projects/${REF}/functions`) {
      res.writeHead(opts.inventoryStatus ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(opts.inventory ?? repoFunctions().map((slug) => ({
        slug,
        status: "ACTIVE",
      }))));
      return;
    }
    if (url.pathname === `/v1/projects/${REF}/api-keys`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ name: "service_role", api_key: "stub-service-key" }]));
      return;
    }
    const match = /^\/functions\/v1\/(.+)$/.exec(url.pathname);
    if (match) {
      const answer = handler(match[1]);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (answer.requestId) headers["x-request-id"] = "11111111-2222-4333-8444-555555555555";
      res.writeHead(answer.status, headers);
      res.end(answer.body);
      return;
    }
    res.writeHead(404).end("no");
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  const port = (server!.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

function repoFunctions(): string[] {
  return execFileSync("bash", ["-c", `ls -1 ${join(REPO, "supabase", "functions")}`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((n) => n && !n.startsWith("_"))
    .sort();
}

/**
 * Async on purpose. The stub server runs in THIS process, so a synchronous
 * `execFileSync` would block the event loop and the script's very first curl
 * would hang until the test timed out — which is exactly what the first
 * version of this file did.
 */
function run(
  base: string,
  functionsDir = join(REPO, "supabase", "functions"),
  repoFunctionsSh?: string,
): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(
      "bash",
      [SCRIPT],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SUPABASE_PROJECT_REF: REF,
          SUPABASE_ACCESS_TOKEN: "stub-token",
          MANAGEMENT_API: base,
          FUNCTIONS_BASE: `${base}/functions/v1`,
          FUNCTIONS_DIR: functionsDir,
        ...(repoFunctionsSh ? { REPO_FUNCTIONS: repoFunctionsSh } : {}),
          // A stub on 127.0.0.1 must not be routed through an egress proxy.
          http_proxy: "",
          https_proxy: "",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          NO_PROXY: "127.0.0.1,localhost",
        },
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        done({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

/** A throwaway functions tree, for the cases that are about the file list. */
function fakeTree(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "fns-"));
  for (const n of names) {
    mkdirSync(join(dir, n), { recursive: true });
    writeFileSync(join(dir, n, "index.ts"), "// stub\n");
  }
  return dir;
}

describe("verify-deployment", () => {
  it("passes against a healthy project, probing every function this repo ships", async () => {
    const base = await stub({});
    const { code, out } = await run(base);
    expect(out).toContain("DEPLOYMENT VERIFY PASS");
    expect(code).toBe(0);
    // Not a vacuous pass: the real directory listing has to have been walked.
    for (const name of repoFunctions()) expect(out).toContain(name);
  });

  it("fails when a function in the repo was never deployed", async () => {
    // `supabase functions deploy` reports success per bundle; a function that
    // never made it is invisible to a probe that only asks about what it
    // already found on the project.
    const base = await stub({
      inventory: repoFunctions().filter((s) => s !== "complete-walk").map((slug) => ({
        slug,
        status: "ACTIVE",
      })),
    });
    const { code, out } = await run(base);
    expect(code).not.toBe(0);
    expect(out).toContain("complete-walk is in this repository but NOT deployed");
  });

  it("fails when a deployed function is not ACTIVE", async () => {
    const base = await stub({
      inventory: repoFunctions().map((slug) => ({
        slug,
        status: slug === "charge-overage" ? "THROTTLED" : "ACTIVE",
      })),
    });
    const { code, out } = await run(base);
    expect(code).not.toBe(0);
    expect(out).toMatch(/charge-overage is deployed but its status is 'THROTTLED'/);
  });

  it("names a function that deployed but does not boot", async () => {
    // The headline finding: this is what "deployed successfully" looks like
    // when the module throws while evaluating.
    const base = await stub({
      fn: (name) =>
        name === "credential-vault"
          ? { status: 500, body: JSON.stringify({ code: "BOOT_ERROR", message: "boot failed" }) }
          : healthy(name),
    });
    const { code, out } = await run(base);
    expect(code).not.toBe(0);
    expect(out).toContain("credential-vault FAILED TO BOOT");
  });

  it("fails when a POST-only function answers a GET", async () => {
    // A GET that reaches a money handler is a charge that can be prefetched,
    // linked and cached.
    const base = await stub({
      fn: (name) =>
        name === "charge-overage"
          ? { status: 200, body: JSON.stringify({ ok: true }), requestId: true }
          : healthy(name),
    });
    const { code, out } = await run(base);
    expect(code).not.toBe(0);
    expect(out).toContain("charge-overage answered HTTP 200, expected 405");
  });

  it("fails on a 405 that did not come from our own wrapper", async () => {
    // The half that makes the probe mean something. A gateway in front of a
    // function that never booted can answer 405 too; only `serveFunction`
    // sets x-request-id, so its absence says the refusal was not ours.
    const base = await stub({
      fn: (name) =>
        name === "billing-portal"
          ? { status: 405, body: JSON.stringify({ error: { code: "method_not_allowed" } }) }
          : healthy(name),
    });
    const { code, out } = await run(base);
    expect(code).not.toBe(0);
    expect(out).toContain("billing-portal answered 405 with no x-request-id");
  });

  it("fails when the unsubscribe link answers 405", async () => {
    // The regression this whole probe found. `unsubscribe` shipped behind
    // serveFunction's POST-only gate, so every recipient who clicked the link
    // in their email got a JSON 405 — the endpoint's own tests drove the
    // handler and never went through the gate.
    const base = await stub({
      fn: (name) =>
        name === "unsubscribe"
          ? {
            status: 405,
            body: JSON.stringify({ error: { code: "method_not_allowed" } }),
            requestId: true,
          }
          : healthy(name),
    });
    const { code, out } = await run(base);
    expect(code).not.toBe(0);
    expect(out).toContain("unsubscribe answered HTTP 405, expected 200");
  });

  it("refuses a bespoke contract that names a function the repo no longer ships", async () => {
    // A stale exception is worse than a missing one: it silently excuses a
    // function from the default probe forever.
    const dir = fakeTree(["complete-walk", "stripe-webhook"]);
    const base = await stub({
      inventory: [
        { slug: "complete-walk", status: "ACTIVE" },
        { slug: "stripe-webhook", status: "ACTIVE" },
      ],
    });
    const { code, out } = await run(base, dir);
    expect(code).not.toBe(0);
    expect(out).toContain("contract_for names 'unsubscribe'");
  });

  it("refuses to report success on an empty function set", async () => {
    const dir = fakeTree([]);
    const base = await stub({ inventory: [] });
    const { code, out } = await run(base, dir);
    expect(code).not.toBe(0);
    expect(out).toContain("no function directories found");
  });

  it("fails when the inventory helper exits non-zero after partial output", async () => {
    // Codex round 3 on PR #87. `scripts/repo-functions.sh` became a
    // subprocess, and this script runs `set -uo pipefail` WITHOUT `-e`, so
    // `expected=$(repo_functions)` keeps whatever the helper managed to print
    // and the following `[ -z "$expected" ]` resets `$?`. A helper that
    // printed two names and then died therefore left the verifier probing a
    // PARTIAL set and reporting DEPLOYMENT VERIFY PASS — every unprinted
    // function silently unverified, which is the exact class this script
    // exists to catch.
    // The partial list deliberately still carries all three bespoke-contract
    // names, so `contract_for`'s stale-exception check does NOT fire. Without
    // that the case goes red for the wrong reason and proves nothing: the
    // first draft of this test did exactly that.
    const all = ["complete-walk", "platform-webhook", "stripe-webhook", "unsubscribe"];
    const dir = fakeTree(all);
    const broken = join(mkdtempSync(join(tmpdir(), "rf-")), "repo-functions.sh");
    writeFileSync(
      broken,
      "#!/usr/bin/env bash\nprintf 'platform-webhook\\nstripe-webhook\\nunsubscribe\\n'\nexit 9\n",
      { mode: 0o755 },
    );
    const base = await stub({
      inventory: all.map((slug) => ({ slug, status: "ACTIVE" })),
    });
    const { code, out } = await run(base, dir, broken);
    expect(code).not.toBe(0);
    expect(out).toContain("could not list the functions this repository ships");
    expect(out).not.toContain("DEPLOYMENT VERIFY PASS");
  });

  it("fails, rather than skipping, when the project cannot be listed", async () => {
    const base = await stub({ inventoryStatus: 500, inventory: [] });
    const { code, out } = await run(base);
    expect(code).not.toBe(0);
    expect(out).toContain("could not list deployed functions (HTTP 500)");
  });
});

/**
 * The script's safety argument, derived rather than enumerated.
 *
 * `verify-deployment.sh` runs against PRODUCTION, and it is read-only only
 * because every probe is a GET that returns before any code can write: a
 * `serveFunction` function refuses a non-POST before calling its handler.
 * Two things break that, and each needs a bespoke `contract_for` case — a
 * decision recorded in the script — before its first probe goes out:
 *
 *   - a function with its own `Deno.serve`, which answers whatever it likes
 *     (`stripe-webhook`, `platform-webhook`);
 *   - `serveFunction` widened with a `methods` list that contains `"GET"`,
 *     which lets a GET reach the handler (`unsubscribe`, whose GET is the
 *     one-click link) — however the key is spelled. A literal list without
 *     it, `["POST"]` or `[]`, admits no GET and is no door. Options, keys,
 *     arguments or a list the scan cannot read count as this door, since
 *     what they hide could be `methods` or `"GET"`.
 *
 * The script's header named them from memory — "every function but two" was
 * "12 of the 13" once and wrong the next PR — so this reads the source for
 * both doors and holds `contract_for` to exactly that set, in both directions:
 * a missing case is a probe that may reach a handler; a case for a function
 * that no longer needs one is an exception that outlived its reason
 * (spec-drift audit).
 */
const FUNCTIONS_ROOT = join(REPO, "supabase", "functions");

/** Function directories, by the predicate `scripts/repo-functions.sh` uses. */
function functionDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .filter((e) => existsSync(join(root, e.name, "index.ts")))
    .map((e) => e.name)
    .sort();
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith(".ts") && !/(_test|\.test)\.ts$/.test(e.name) ? [p] : [];
  });
}

/** A name only running the code would tell: a computed key, `obj[expr]`. */
const UNREADABLE = Symbol("unreadable");

const literalText = (e: ts.Expression): string | undefined =>
  ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e) ? e.text : undefined;

/**
 * The name a property key spells, however it is spelled — `methods`,
 * `"methods"`, `["methods"]`, `` [`methods`] `` — or UNREADABLE. Not
 * `getText()`, which keeps the quotes: that is how `{ "methods": ["GET"] }`
 * read as POST-only (Codex, on #97).
 */
function keyOf(name: ts.PropertyName): string | typeof UNREADABLE {
  if (ts.isComputedPropertyName(name)) return literalText(unwrap(name.expression)) ?? UNREADABLE;
  return name.text;
}

type Access = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/** The member an access names — `a.b`, `a["b"]`, `` a[`b`] `` — or UNREADABLE. */
function memberOf(e: Access): string | typeof UNREADABLE {
  return ts.isPropertyAccessExpression(e) ? e.name.text : literalText(unwrap(e.argumentExpression)) ?? UNREADABLE;
}

type Wrapper =
  | ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression
  | ts.TypeAssertion | ts.NonNullExpression;

/**
 * A node that changes nothing at run time: `( )`, `as`, `satisfies`, `<T>`,
 * `!`. The scan reads through one wherever it reads an expression — the
 * options object, a key, a member, a list and its entries, the `Deno`
 * receiver, a callee — because each place it did not was a finding (Codex, on
 * #97, twice), and two of them hid a door rather than inventing one.
 */
function isWrapper(n: ts.Node): n is Wrapper {
  return ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)
    || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n);
}

/**
 * A comma evaluates its operands in order and yields the last, so `(0, f)`
 * is `f`, the shape a bundler writes. The scan reads its right operand
 * wherever it reads through a wrapper, down into a value and up from one
 * (Codex, on #97: `(0, http[name])(…)` read as indexing that is not called).
 */
const isComma = (n: ts.Node): n is ts.BinaryExpression =>
  ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken;

/** Whether `parent` hands `child`'s value on unchanged: a wrapper around it, or a comma it ends. */
const handsOn = (parent: ts.Node, child: ts.Node): boolean =>
  (isWrapper(parent) && parent.expression === child) || (isComma(parent) && parent.right === child);

/** An expression with its wrappers removed, and a comma read as its right operand. */
function unwrap(value: ts.Expression): ts.Expression {
  let e = value;
  for (;;) {
    if (isWrapper(e)) e = e.expression;
    else if (isComma(e)) e = e.right;
    else return e;
  }
}

/**
 * Whether an import or export specifier is type-only — `import type { … }`,
 * `export type { … }`, or a `type` modifier on the specifier itself. It is
 * erased like a type, so an alias it declares names nothing that runs (Codex,
 * on #97: `import type { serveFunction as Serve }` read as a renaming import).
 */
function typeOnlySpecifier(spec: ts.ImportSpecifier | ts.ExportSpecifier): boolean {
  if (spec.isTypeOnly) return true;
  const holder = spec.parent.parent; // NamedImports → ImportClause, NamedExports → ExportDeclaration
  return (ts.isImportClause(holder) || ts.isExportDeclaration(holder)) && holder.isTypeOnly;
}

/**
 * Whether `id` is a name being DECLARED rather than read: the name of a
 * variable, parameter, function, class, import, export or property key. A
 * declaration runs nothing; the name is judged where it is called. Restated
 * rather than taken from the compiler, whose isDeclarationName is not public
 * API — a gate that breaks on a compiler upgrade is red on a healthy tree. A
 * property access's name is judged as the access, and a shorthand property
 * reads the variable it names, so neither is a declaration here.
 */
function declaresName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) || ts.isShorthandPropertyAssignment(p)) return false;
  return (p as { name?: ts.Node }).name === id;
}

/** Whether `id` is the source side of an alias, which is judged at the alias itself. */
const aliasSource = (id: ts.Identifier): boolean =>
  (ts.isImportSpecifier(id.parent) || ts.isExportSpecifier(id.parent) || ts.isBindingElement(id.parent))
  && id.parent.propertyName === id;

/**
 * Whether `node` is being ASSIGNED TO rather than read: the left of `=`, an
 * element of a literal that is (a property's value, a shorthand's name, a
 * spread, an array element), or the variable of a `for … of`/`for … in`. A
 * shorthand's DEFAULT is evaluated, not assigned to, so only its name counts.
 * A caller passes the outermost wrapper (`(serveFunction as any) = …`); a
 * wrapped pattern is not a valid target at all. The channel and FormError
 * scans carry their own copy of this rule.
 */
function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node;
  if ((ts.isPropertyAssignment(parent) && parent.initializer === node)
    || (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
    || ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) return isAssignmentTarget(parent.parent);
  if (ts.isArrayLiteralExpression(parent)) return isAssignmentTarget(parent);
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === node;
  return false;
}

/**
 * The key a destructuring element takes and the local side it lands in, or
 * undefined if `node` is none: an element of an object binding pattern
 * (`const { a: b } = …`) or a property of an object literal being assigned to
 * (`({ a: b } = …)`). A rest element takes no one member, and an array
 * pattern takes by position, so neither names one.
 */
function destructured(node: ts.Node): { key: string | typeof UNREADABLE; local: ts.Node } | undefined {
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken) {
    const key = node.propertyName ? keyOf(node.propertyName) : ts.isIdentifier(node.name) ? node.name.text : UNREADABLE;
    return { key, local: node.name };
  }
  if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && isAssignmentTarget(node.parent)) {
    return { key: keyOf(node.name), local: ts.isPropertyAssignment(node) ? node.initializer : node.name };
  }
  return undefined;
}

/** Whether a destructuring's local side is serveFunction itself, default or not — a rename of nothing. */
function keepsName(local: ts.Node): boolean {
  let e = local;
  if (ts.isExpression(e)) {
    e = unwrap(e);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) e = unwrap(e.left);
  }
  return ts.isIdentifier(e) && e.text === "serveFunction";
}

/** Whether an access is the callee of a call, through any wrappers. */
function isCalled(access: Access): boolean {
  const held = outermost(access);
  return ts.isCallExpression(held.parent) && held.parent.expression === held;
}

/** Whether `node` sits in a type (`typeof serveFunction`), which nothing runs. */
function inType(node: ts.Node): boolean {
  for (let n = node.parent; n && !ts.isStatement(n) && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isTypeNode(n)) return true;
  }
  return false;
}

/** The outermost node handing `node`'s value on: what a call or an access actually holds. */
function outermost(node: ts.Expression): ts.Expression {
  let e = node;
  while (e.parent && handsOn(e.parent, e)) e = e.parent as ts.Expression;
  return e;
}

/**
 * Whether a `methods` value can let a GET through. `handleRequest` admits a
 * method only when the list contains it exactly, so a literal list is a door
 * only if one of its entries is `"GET"` — `["POST"]` and `[]` admit none
 * (Codex, on #97). The list AND each entry are unwrapped the same way, since
 * `["POST" as const]` is still `["POST"]` (Codex again). Anything the scan
 * cannot read — a variable, a spread, an entry that is not a literal — could
 * be `"GET"`, so it is a door.
 */
function admitsGet(value: ts.Expression): boolean {
  const e = unwrap(value);
  if (!ts.isArrayLiteralExpression(e)) return true;
  return e.elements.some((el) => {
    const text = ts.isSpreadElement(el) ? undefined : literalText(unwrap(el));
    return text === undefined || text === "GET";
  });
}

/** Why this serveFunction call's options might admit a GET, or null if they cannot. */
function widening(call: ts.CallExpression): string | null {
  if (call.arguments.some(ts.isSpreadElement)) return "serveFunction arguments spread from elsewhere";
  const options = call.arguments[1] && unwrap(call.arguments[1]);
  if (!options) return null;
  if (!ts.isObjectLiteralExpression(options)) return "serveFunction options the scan cannot read";
  const keys = options.properties.map((p) => (ts.isSpreadAssignment(p) ? null : keyOf(p.name)));
  if (keys.includes(null)) return "serveFunction options spread from elsewhere";
  if (keys.includes(UNREADABLE)) return "serveFunction options with a key the scan cannot read";
  for (const p of options.properties) {
    if (ts.isSpreadAssignment(p) || keyOf(p.name) !== "methods") continue;
    // A shorthand, a method or an accessor supplies a value the scan cannot read.
    if (!ts.isPropertyAssignment(p) || admitsGet(p.initializer)) return "serveFunction widened with methods";
  }
  return null;
}

/**
 * name -> how a GET can reach its code, for every function where it can.
 * A function with neither a `Deno.serve` nor a `serveFunction` call is
 * reported too: the scan cannot see how it serves, which is not "safe".
 *
 * Every REFERENCE is judged, not only the calls the scan recognises, because
 * a function that serves the ordinary way beside a call the scan cannot see
 * never reaches that fallback: `Deno.serve` however it is spelled is a door,
 * called or not; `serveFunction` must be called where it is named, or its
 * options are out of sight (a bare alias, or a rename away from it on an
 * import, an export or a destructuring, declared or assigned, its source
 * spelled however it can be — the local side of a rename, and any name being
 * declared or assigned to, is judged where it is called instead); a key the
 * scan cannot read, destructured under another name, and a call through a
 * member it cannot read could each be serveFunction; and a member of `Deno`
 * the scan cannot read could be `serve`. What stays outside: a second serve
 * reached through a name the scan never sees at all (`const { serve } =
 * Deno`, an alias of `Deno` itself, a member the scan cannot read taken by
 * indexing and called later) beside a first one it does — one serve per
 * function is the shape the runtime runs, and the fallback covers it.
 */
function getReachable(root: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of functionDirs(root)) {
    let serves = false;
    const door = (why: string) => {
      serves = true;
      found.set(name, why);
    };
    for (const file of tsFiles(join(root, name))) {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        // A type is erased, so nothing in one serves — either name (Codex, on #97).
        const runs = !inType(node);
        const access = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node : undefined;
        const member = access && memberOf(access);
        const receiver = access && unwrap(access.expression);
        if (runs && receiver && ts.isIdentifier(receiver) && receiver.text === "Deno") {
          if (member === "serve") door("its own Deno.serve");
          else if (member === UNREADABLE) door("a member of Deno the scan cannot read");
        } else if (runs && access && member === UNREADABLE && isCalled(access)) {
          // `http[name](…)` is the unreadable destructured key below without
          // the destructuring (Codex, on #97). Indexing that is not called is
          // ordinary code — `OUTCOME_MESSAGES[outcome]`, three such reads in
          // the functions today — so only a call counts, and there is none.
          door("a call through a member the scan cannot read could be serveFunction, so the scan cannot see its options");
        }
        // An alias hides serveFunction's calls when it renames serveFunction
        // AWAY: its source side names serveFunction and its local side does
        // not — `import { serveFunction as serve }`, `export { serveFunction
        // as serve }` (the source an identifier or a string), and `const {
        // serveFunction: serve } = …` or `({ serveFunction: serve } = …)`
        // (the key spelled however a key can be; Codex, on #97, for the
        // assignment). The other side of an alias, serveFunction as the new
        // name for something else, renames nothing of its away (Codex, on
        // #97); an alias that keeps the name is no rename; and a type-only
        // specifier is erased. Judged here, at the alias, so neither side is
        // read again below as a bare reference.
        if (runs && (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && node.propertyName
          && node.propertyName.text === "serveFunction" && node.name.text !== "serveFunction"
          && !typeOnlySpecifier(node)) {
          door(`serveFunction ${ts.isImportSpecifier(node) ? "imported" : "exported"} under another name, so the scan cannot see its calls`);
        }
        // A destructured key the scan cannot read could be serveFunction
        // (Codex, on #97): that costs nothing today, since the functions
        // destructure with no computed key and assign by destructuring
        // nowhere (measured: 198 object binding elements in 16 functions).
        const taken = runs ? destructured(node) : undefined;
        if (taken && (taken.key === "serveFunction" || taken.key === UNREADABLE) && !keepsName(taken.local)) {
          door(taken.key === UNREADABLE
            ? "a key the scan cannot read, destructured under another name, could be serveFunction, so the scan cannot see its calls"
            : "serveFunction destructured under another name, so the scan cannot see its calls");
        }
        // A name being written — declared, or assigned to — is judged where it
        // is called: `let serveFunction; ({ serveFunction } = http)`,
        // `serveFunction = make()` and `http.serveFunction = make()` pass
        // nothing on, and a call of it is read.
        const namesServeFunction = runs
          && ((ts.isIdentifier(node) && node.text === "serveFunction" && !declaresName(node) && !aliasSource(node))
            || member === "serveFunction")
          && !isAssignmentTarget(outermost(node as ts.Expression));
        if (namesServeFunction) {
          const held = outermost(node as ts.Expression);
          const parent = held.parent;
          if (ts.isCallExpression(parent) && parent.expression === held) {
            serves = true;
            const why = widening(parent);
            if (why) found.set(name, why);
          } else if (!(ts.isPropertyAccessExpression(parent) && parent.name === node)) {
            // (the name of `http.serveFunction` is judged as that access)
            door("serveFunction referenced without being called, so the scan cannot see its options");
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    if (!serves) found.set(name, "neither Deno.serve nor serveFunction — the scan cannot see how it serves");
  }
  return found;
}

/** The bespoke cases in `contract_for`, and the names its stale-exception loop checks. */
function scriptExceptions(): { arms: string[]; loop: string[] } {
  const script = readFileSync(SCRIPT, "utf8");
  const body = /contract_for\(\)\s*\{([\s\S]*?)\n\}/.exec(script)?.[1] ?? "";
  const arms = [...body.matchAll(/^\s*([a-z0-9-]+)\)\s/gm)].map((m) => m[1]).sort();
  const loop = (/^for special in ([^;]+); do$/m.exec(script)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).sort();
  return { arms, loop };
}

describe("verify-deployment's read-only argument is derived", () => {
  it("gives every function a GET can reach its own contract, and no other function one", () => {
    const reachable = getReachable(FUNCTIONS_ROOT);
    const { arms } = scriptExceptions();
    // Preconditions: the scan found the functions, and the script parser
    // found its cases — either one empty would agree with anything.
    expect(functionDirs(FUNCTIONS_ROOT).length, "no function directories found").toBeGreaterThan(10);
    expect(arms.length, "contract_for has no bespoke cases — the parser is blind").toBeGreaterThan(0);
    const missing = [...reachable].filter(([n]) => !arms.includes(n)).map(([n, why]) => `${n} (${why})`);
    const stale = arms.filter((n) => !reachable.has(n));
    expect(missing, `a GET can reach these, and contract_for has no case for them: ${missing.join(", ")}`).toEqual([]);
    expect(stale, `contract_for excuses these, and a GET can no longer reach them: ${stale.join(", ")}`).toEqual([]);
  });

  it("checks exactly the contract_for cases for staleness — the same list twice, kept by hand", () => {
    const { arms, loop } = scriptExceptions();
    expect(loop).toEqual(arms);
  });

  it("finds each door, and does not mistake prose or the default for one", () => {
    const root = mkdtempSync(join(tmpdir(), "doors-"));
    const fn = (name: string, files: Record<string, string>) => {
      mkdirSync(join(root, name), { recursive: true });
      for (const [f, text] of Object.entries(files)) writeFileSync(join(root, name, f), text);
    };
    fn("bare", { "index.ts": "Deno.serve(async (req) => new Response(req.method));" });
    fn("widened", { "index.ts": 'serveFunction(h, { methods: ["GET", "POST"] });' });
    fn("default", { "index.ts": "// Deno.serve is not used here\nserveFunction(async (req) => handle(req));" });
    fn("opaque", { "index.ts": "serveFunction(h, OPTIONS);" });
    fn("spread", { "index.ts": "serveFunction(h, { ...OPTIONS });" });
    fn("in-a-handler", { "index.ts": 'import "./server.ts";', "server.ts": "Deno.serve(() => new Response());" });
    fn("unserved", { "index.ts": "export const x = 1;" });
    fn("_lib", { "index.ts": "Deno.serve(() => new Response());" });
    const reachable = Object.fromEntries(getReachable(root));
    expect(reachable).toEqual({
      bare: "its own Deno.serve",
      widened: "serveFunction widened with methods",
      opaque: "serveFunction options the scan cannot read",
      spread: "serveFunction options spread from elsewhere",
      "in-a-handler": "its own Deno.serve",
      unserved: "neither Deno.serve nor serveFunction — the scan cannot see how it serves",
    });
  });

  it("reads a key however it is spelled, and refuses one it cannot read (Codex, on #97)", () => {
    // `{ "methods": ["GET"] }` is the same widening as `{ methods: … }`, and
    // the scan read the key with getText(), which keeps the quotes — so the
    // function was classed POST-only and verify-deployment would have sent
    // its handler an authenticated GET.
    const root = mkdtempSync(join(tmpdir(), "keys-"));
    const fn = (name: string, text: string) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "index.ts"), text);
    };
    fn("quoted", 'serveFunction(h, { "methods": ["GET"] });');
    fn("single-quoted", "serveFunction(h, { 'methods': [\"GET\"] });");
    fn("computed", 'serveFunction(h, { ["methods"]: ["GET"] });');
    fn("computed-template", 'serveFunction(h, { [`methods`]: ["GET"] });');
    fn("shorthand", 'const methods = ["GET"];\nserveFunction(h, { methods });');
    fn("computed-unreadable", 'serveFunction(h, { [KEY]: ["GET"] });');
    fn("spread-arguments", "serveFunction(...ARGS);");
    // Not doors: a key the scan reads that is not `methods`, and the plain
    // default. Without these, refusing every options object would pass.
    fn("other-key", "serveFunction(h, { timeout: 5 });");
    fn("imported", 'import { serveFunction } from "../_lib/http.ts";\nserveFunction(h);');
    expect(Object.fromEntries(getReachable(root))).toEqual({
      quoted: "serveFunction widened with methods",
      "single-quoted": "serveFunction widened with methods",
      computed: "serveFunction widened with methods",
      "computed-template": "serveFunction widened with methods",
      shorthand: "serveFunction widened with methods",
      "computed-unreadable": "serveFunction options with a key the scan cannot read",
      "spread-arguments": "serveFunction arguments spread from elsewhere",
    });
  });

  it("reads the methods a widening lists, as handleRequest does (Codex, on #97)", () => {
    // handleRequest lets a method through only when the list contains it
    // exactly, so an explicit POST-only or empty list is no door. Without
    // this the gate would demand a contract_for case for a function no GET
    // can reach — a red on healthy code.
    const root = mkdtempSync(join(tmpdir(), "methods-"));
    const fn = (name: string, text: string) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "index.ts"), text);
    };
    fn("post-only", 'serveFunction(h, { methods: ["POST"] });');
    fn("post-only-as-const", 'serveFunction(h, { methods: ["POST"] as const });');
    fn("empty", "serveFunction(h, { methods: [] });");
    fn("lowercase", 'serveFunction(h, { methods: ["get"] });');
    fn("get-as-const", 'serveFunction(h, { methods: ["GET", "POST"] as const });');
    fn("unreadable-entry", "serveFunction(h, { methods: [METHOD, \"POST\"] });");
    fn("spread-entry", 'serveFunction(h, { methods: [...EXTRA, "POST"] });');
    fn("variable", "serveFunction(h, { methods: METHODS });");
    fn("accessor", 'serveFunction(h, { get methods() { return ["POST"]; } });');
    // Each ENTRY is unwrapped too, not only the list (Codex, on #97): a
    // wrapped "POST" is still "POST", and a wrapped "GET" is still a door.
    fn("post-entry-as-const", 'serveFunction(h, { methods: ["POST" as const] });');
    fn("post-entry-paren", 'serveFunction(h, { methods: [("POST")] });');
    fn("post-entry-satisfies", 'serveFunction(h, { methods: ["POST" satisfies string] });');
    fn("post-entry-assertion", 'serveFunction(h, { methods: [<const>"POST"] });');
    fn("post-entry-nested", 'serveFunction(h, { methods: [(("POST") as const)] });');
    fn("post-list-non-null", 'serveFunction(h, { methods: ["POST"]! });');
    fn("get-entry-as-const", 'serveFunction(h, { methods: ["GET" as const] });');
    fn("get-entry-paren", 'serveFunction(h, { methods: [("POST"), (("GET"))] });');
    // The options object and a computed key are unwrapped the same way
    // (Codex again): a wrapper changes nothing handleRequest sees.
    fn("options-paren", 'serveFunction(h, ({ methods: ["POST"] }));');
    fn("options-as-const", 'serveFunction(h, ({ methods: ["POST"] } as const));');
    fn("options-satisfies", 'serveFunction(h, { methods: ["POST"] } satisfies ServeOptions);');
    fn("options-paren-get", 'serveFunction(h, ({ methods: ["GET"] }));');
    fn("key-paren-post", 'serveFunction(h, { [("methods")]: ["POST"] });');
    fn("key-paren-get", 'serveFunction(h, { [("methods")]: ["GET"] });');
    expect(Object.fromEntries(getReachable(root))).toEqual({
      "options-paren-get": "serveFunction widened with methods",
      "key-paren-get": "serveFunction widened with methods",
      "get-entry-as-const": "serveFunction widened with methods",
      "get-entry-paren": "serveFunction widened with methods",
      "get-as-const": "serveFunction widened with methods",
      "unreadable-entry": "serveFunction widened with methods",
      "spread-entry": "serveFunction widened with methods",
      variable: "serveFunction widened with methods",
      accessor: "serveFunction widened with methods",
    });
  });

  it("sees every call of serveFunction and every Deno.serve, however it is reached", () => {
    // The fallback ("neither …") covers a function whose only serve the scan
    // cannot see. These are the cases it cannot cover: a serve the scan does
    // see, beside one it does not.
    const root = mkdtempSync(join(tmpdir(), "callees-"));
    const fn = (name: string, text: string) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "index.ts"), text);
    };
    fn("namespace", 'serveFunction(h);\nhttp.serveFunction(g, { methods: ["GET"] });');
    fn("element", 'serveFunction(h);\nhttp["serveFunction"](g, { methods: ["GET"] });');
    fn("alias", 'import { serveFunction } from "../_lib/http.ts";\nserveFunction(h);\n'
      + 'const serve = serveFunction;\nserve(g, { methods: ["GET"] });');
    fn("renamed", 'import { serveFunction as serve } from "../_lib/http.ts";\nserve(h, { methods: ["GET"] });');
    fn("deno-element", "serveFunction(h);\nDeno[\"serve\"](g);");
    fn("deno-template", "serveFunction(h);\nDeno[`serve`](g);");
    fn("deno-unreadable", "serveFunction(h);\nDeno[method](g);");
    fn("deno-alias", "serveFunction(h);\nconst serve = Deno.serve;\nserve(g);");
    // Wrapped, each is the same reference (Codex, on #97). The two beside a
    // plain serveFunction(h) were silent misses: no door at all.
    fn("element-paren", 'serveFunction(h);\nhttp[("serveFunction")](g, { methods: ["GET"] });');
    fn("deno-paren", "serveFunction(h);\n(Deno as any).serve(g);");
    fn("deno-element-paren", 'serveFunction(h);\nDeno[("serve")](g);');
    fn("callee-as-get", '(serveFunction as typeof serveFunction)(h, { methods: ["GET"] });');
    // Not doors: other members of Deno, read the ordinary way; and a wrapped
    // callee is still a call, whose options the scan reads.
    fn("deno-env", 'serveFunction(h);\nconst url = Deno.env.get("SUPABASE_URL");');
    fn("callee-paren", '(serveFunction)(h, { methods: ["POST"] });');
    // A type is not a reference: nothing runs `typeof serveFunction`.
    fn("type-mention", 'type Serve = typeof serveFunction;\nserveFunction(h);');
    // Nor for Deno.serve (Codex, on #97). `typeof Deno.serve` parses as a
    // qualified name, which no branch reads; a computed key in a type literal
    // is a real property access, and it is erased all the same.
    fn("deno-type", "serveFunction(h);\ntype Serve = typeof Deno.serve;");
    fn("deno-type-key", "serveFunction(h);\ntype K = { [Deno.serve.name]: string };");
    // A type-only import or export is erased too, so its alias names nothing
    // that runs (Codex, on #97): beside an ordinary POST-only call, none of
    // these is a door, however the `type` is written.
    fn("type-import", 'import type { serveFunction as Serve } from "../_lib/http.ts";\n'
      + 'import { serveFunction } from "../_lib/http.ts";\nserveFunction(h);');
    fn("type-specifier", 'import { type serveFunction as Serve, serveFunction } from "../_lib/http.ts";\nserveFunction(h);');
    fn("type-export", 'export type { serveFunction as Serve } from "../_lib/http.ts";\nserveFunction(h);');
    fn("type-export-specifier", 'export { type serveFunction as Serve } from "../_lib/http.ts";\nserveFunction(h);');
    // A value export under another name is still a door — another module calls
    // it under a name the scan does not look for — and the red says exported.
    fn("export-renamed", 'import { serveFunction } from "../_lib/http.ts";\nserveFunction(h);\nexport { serveFunction as serve };');
    // Only a rename AWAY from serveFunction hides its calls. The other side of
    // an alias — serveFunction as the new name for something else — renames
    // nothing of its away (Codex, on #97), nor does an alias that keeps the
    // name; the local serveFunction is judged where it is called.
    fn("reverse-export", 'import { serveFunction } from "../_lib/http.ts";\nserveFunction(h);\n'
      + 'export { helper as serveFunction } from "./helper.ts";');
    fn("reverse-import", 'import { serve as serveFunction } from "./serve.ts";\nserveFunction(h);');
    fn("reverse-destructure", "const { serve: serveFunction } = mod;\nserveFunction(h);");
    fn("same-name-import", 'import { serveFunction as serveFunction } from "../_lib/http.ts";\nserveFunction(h);');
    fn("shorthand-destructure", "const { serveFunction } = http;\nserveFunction(h);");
    // And the source side is read however it is spelled: a string names it in
    // an import, and a destructured key is a key.
    fn("string-import", 'import { "serveFunction" as serve } from "../_lib/http.ts";\nserveFunction(h);\n'
      + 'serve(g, { methods: ["GET"] });');
    fn("destructured", 'serveFunction(h);\nconst { serveFunction: serve } = http;\nserve(g, { methods: ["GET"] });');
    fn("destructured-key", 'serveFunction(h);\nconst { ["serveFunction"]: serve } = http;\nserve(g);');
    // Destructuring takes a member with no access expression at all, and an
    // assignment destructures as well as a declaration does (Codex, on #97):
    // `({ serveFunction: serve } = http)`, in a `for … of`, nested in an array
    // pattern, or with a default. A key the scan cannot read could be
    // serveFunction (Codex again), and so could a member a call is made
    // through: `http[name](…)` is the same unreadable key without the
    // destructuring. Each sits beside a plain serveFunction(h), so none is the
    // fallback.
    fn("destructured-unreadable", 'serveFunction(h);\nconst key = "serveFunction";\n'
      + 'const { [key]: serve } = http;\nserve(g, { methods: ["GET"] });');
    fn("assigned", 'serveFunction(h);\nlet serve;\n({ serveFunction: serve } = http);\nserve(g, { methods: ["GET"] });');
    fn("assigned-unreadable", "serveFunction(h);\nlet serve;\n({ [key]: serve } = http);\nserve(g);");
    fn("assigned-default", "serveFunction(h);\nlet serve;\n({ serveFunction: serve = fallback } = http);\nserve(g);");
    fn("assigned-for-of", "serveFunction(h);\nlet serve;\nfor ({ serveFunction: serve } of mods) serve(g);");
    fn("assigned-nested", "serveFunction(h);\nlet serve;\n[{ serveFunction: serve }] = pairs;\nserve(g);");
    fn("indexed-unreadable", 'serveFunction(h);\nhttp[name](g, { methods: ["GET"] });');
    // A default is evaluated, not assigned to: serveFunction as a shorthand's
    // default is read, and handed to `serve`.
    fn("assigned-default-read", 'serveFunction(h);\nlet serve;\n({ serve = serveFunction } = mod);\nserve(g, { methods: ["GET"] });');
    // A comma yields its right operand, so `(0, f)(…)` calls f, the shape a
    // bundler writes (Codex, on #97). The right operand is the value wherever
    // the scan reads one: a callee, a receiver, the options. The left operand
    // is evaluated and dropped, so a reference there is not a call.
    fn("comma-indexed", 'serveFunction(h);\n(0, http[name])(g, { methods: ["GET"] });');
    fn("comma-deno", "serveFunction(h);\n(0, Deno).serve(g);");
    fn("comma-deno-unreadable", "serveFunction(h);\n(0, Deno)[k](g);");
    fn("comma-callee-get", '(0, serveFunction)(h, { methods: ["GET"] });');
    fn("comma-options-get", 'serveFunction(h, (0, { methods: ["GET"] }));');
    fn("comma-left", "(serveFunction, other)(h);");
    fn("comma-callee-post", '(0, serveFunction)(h, { methods: ["POST"] });');
    fn("comma-options-post", 'serveFunction(h, (0, { methods: ["POST"] }));');
    // Not doors. A destructuring assignment that keeps the name, or assigns
    // something else TO serveFunction, is the declaration forms' twin: the
    // local serveFunction is written, and judged where it is called — as is a
    // plain assignment to it. An unreadable key whose local side keeps the
    // name renames nothing; an object BUILT with a serveFunction key is data;
    // and indexing that is not called is ordinary code (three such reads in
    // the functions today, `OUTCOME_MESSAGES[outcome]` among them).
    fn("assigned-shorthand", "let serveFunction;\n({ serveFunction } = http);\nserveFunction(h);");
    fn("assigned-reverse", "let serveFunction;\n({ serve: serveFunction } = mod);\nserveFunction(h);");
    fn("assigned-plain", "let serveFunction;\nserveFunction = make();\nserveFunction(h);");
    fn("assigned-wrapped", "let serveFunction;\n(serveFunction as any) = make();\nserveFunction(h);");
    fn("member-assigned", "http.serveFunction = make();\nhttp.serveFunction(h);");
    fn("assigned-keeps-default", "let serveFunction;\n({ serveFunction: serveFunction = fallback } = http);\nserveFunction(h);");
    fn("unreadable-keeps-name", "const { [key]: serveFunction } = mod;\nserveFunction(h);");
    fn("built-object-key", "const routes = { serveFunction: handler };\nserveFunction(h);");
    fn("indexed-uncalled", "serveFunction(h);\nconst message = OUTCOME_MESSAGES[outcome];");
    expect(Object.fromEntries(getReachable(root))).toEqual({
      "element-paren": "serveFunction widened with methods",
      "deno-paren": "its own Deno.serve",
      "deno-element-paren": "its own Deno.serve",
      "callee-as-get": "serveFunction widened with methods",
      namespace: "serveFunction widened with methods",
      element: "serveFunction widened with methods",
      alias: "serveFunction referenced without being called, so the scan cannot see its options",
      renamed: "serveFunction imported under another name, so the scan cannot see its calls",
      "export-renamed": "serveFunction exported under another name, so the scan cannot see its calls",
      "string-import": "serveFunction imported under another name, so the scan cannot see its calls",
      destructured: "serveFunction destructured under another name, so the scan cannot see its calls",
      "destructured-key": "serveFunction destructured under another name, so the scan cannot see its calls",
      "deno-element": "its own Deno.serve",
      "deno-template": "its own Deno.serve",
      "deno-unreadable": "a member of Deno the scan cannot read",
      "deno-alias": "its own Deno.serve",
      "destructured-unreadable": "a key the scan cannot read, destructured under another name, could be serveFunction, so the scan cannot see its calls",
      assigned: "serveFunction destructured under another name, so the scan cannot see its calls",
      "assigned-unreadable": "a key the scan cannot read, destructured under another name, could be serveFunction, so the scan cannot see its calls",
      "assigned-default": "serveFunction destructured under another name, so the scan cannot see its calls",
      "assigned-for-of": "serveFunction destructured under another name, so the scan cannot see its calls",
      "assigned-nested": "serveFunction destructured under another name, so the scan cannot see its calls",
      "indexed-unreadable": "a call through a member the scan cannot read could be serveFunction, so the scan cannot see its options",
      "assigned-default-read": "serveFunction referenced without being called, so the scan cannot see its options",
      "comma-indexed": "a call through a member the scan cannot read could be serveFunction, so the scan cannot see its options",
      "comma-deno": "its own Deno.serve",
      "comma-deno-unreadable": "a member of Deno the scan cannot read",
      "comma-callee-get": "serveFunction widened with methods",
      "comma-options-get": "serveFunction widened with methods",
      "comma-left": "serveFunction referenced without being called, so the scan cannot see its options",
    });
  });
});
