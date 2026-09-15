import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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
      res.end(JSON.stringify(opts.inventory ?? shippedFunctions().map((slug) => ({
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

/**
 * The functions this repository ships, by the ONE predicate the repository
 * keeps. This used to be a third `ls`-and-filter of its own, which is the
 * shape Codex found diverging twice on PR #87 — it missed `index.ts` and
 * dot-directories, and happened to agree with the helper only because no
 * such directory exists yet.
 */
function shippedFunctions(functionsDir = join(REPO, "supabase", "functions")): string[] {
  const out = execFileSync("bash", [join(REPO, "scripts", "repo-functions.sh")], {
    cwd: REPO,
    env: { ...process.env, FUNCTIONS_DIR: functionsDir },
    encoding: "utf8",
  });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
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
    for (const name of shippedFunctions()) expect(out).toContain(name);
  });

  it("fails when a function in the repo was never deployed", async () => {
    // `supabase functions deploy` reports success per bundle; a function that
    // never made it is invisible to a probe that only asks about what it
    // already found on the project.
    const base = await stub({
      inventory: shippedFunctions().filter((s) => s !== "complete-walk").map((slug) => ({
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
      inventory: shippedFunctions().map((slug) => ({
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

// ---------------------------------------------------------------------------
// The read-only argument, derived rather than enumerated
// ---------------------------------------------------------------------------
//
// `verify-deployment.sh` fires a GET at every deployed function, against
// PRODUCTION, and the argument that this is safe is per-function:
//
//   * a function served by `serveFunction` answers 405 before the handler is
//     ever called, for any method it does not allow — one wrapper, checked
//     once, covering every function behind it;
//   * a function with its OWN `Deno.serve` has no such wrapper in front of
//     it, so somebody has to have READ that function and established that a
//     GET reaches nothing. `contract_for` is where that reading is recorded.
//
// The script's header carried the second half as a sentence naming the two
// functions it applies to. A sentence is not a gate: a function that is not
// behind the wrapper silently gets the DEFAULT contract, nobody is asked
// whether a GET is safe against it, and the probe finds out by making the
// request. So the requirement is DERIVED here, and it is a test rather than a
// runtime check in the script because CI runs this on every push while the
// deploy that runs the script is gated on CI being green — so a function with
// no case cannot reach a deploy without going red first.
//
// The rule is stated POSITIVELY, and that is a correction. The first version
// asked the opposite question — does this function have its own `Deno.serve`?
// — which enumerates the ways of bypassing the wrapper instead of requiring
// the wrapper, and Codex showed what that costs: a function that serves
// itself by another perfectly ordinary spelling (an imported `serve(…)`
// helper, `addEventListener("fetch", …)`, a framework's own listener) is
// invisible to the bypass detector, so it takes the default contract and
// nobody ever establishes that a GET against it is read-only. Measured on the
// shipped gate with a planted `probe-serve/index.ts` importing std's `serve`:
// 14 of 14 green. Enumerating the ways something can be wrong is how the next
// one is missed — `verify-photo-integrity.sh` took three rounds to learn it —
// so the question is now "is this function behind the house wrapper?", which
// has one answer and no list. A function that is not must carry a
// `contract_for` case, whatever the reason it is not.
//
// PARSED, not grepped, and the reason is measurable: `platform-webhook`'s own
// header says "Same bare Deno.serve shape as stripe-webhook", so a grep over
// that file counts a COMMENT — and the inverted rule has the mirror-image
// exposure, where a function that does NOT call `serveFunction` mentions the
// name in a comment (four `deps.ts` files in this tree do, explaining why
// importing an `index.ts` binds a port) and a grep would call it housed. A
// comment is not an AST node, and the call has to be a CALL of the name
// imported from `_lib/http.ts` — a local function of the same name proves
// nothing about which wrapper is in front of the request.
//
// Stated rather than chased, on the stopping rule the enum-catalogue
// generator writes down: this catches the mistake, not the adversary. A call
// assembled at run time, or `serveFunction` re-exported through a chain of
// modules, is not followed; nothing in this tree writes anything of the kind.

/** Every non-test `.ts` under `dir`, recursively — a function is the whole
 * directory, not just its `index.ts`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.ts$/.test(e.name) && !/(\.test|_test|\.d)\.ts$/.test(e.name) ? [p] : [];
  });
}

/**
 * The lines where a file CALLS `serveFunction`, imported from `_lib/http.ts`,
 * at a point that RUNS when the module is evaluated.
 *
 * Three conditions, and each is load-bearing.
 *
 * A CALL, because a mention in a comment or a string is not a wrapper in
 * front of a request — and four `deps.ts` files in this tree name
 * `serveFunction` in prose for exactly the reason that makes this worth
 * guarding (importing an `index.ts` runs it and binds a port).
 *
 * Imported from `_lib/http.ts`, because a local function of the same name
 * would answer a question nobody asked: what is in front of the request is
 * the house wrapper or it is not.
 *
 * And UNCONDITIONAL at module scope — a statement of the module itself, not
 * something nested in control flow or in a function body. This came in two
 * rounds and the second corrected the first. A call inside a function nobody
 * invokes serves nothing (Codex planted an `index.ts` serving itself through
 * an imported `serve(…)` beside an `unused.ts` calling the wrapper, and the
 * whole directory read as housed — 14 of 14 green). I then allowed a call
 * inside a module-scope `if`, arguing that refusing it would be red on a
 * healthy tree — an argument I had NOT measured, and `if (false)
 * serveFunction(handle); serve(handle);` reads as housed under it. Measured
 * since: all fourteen real calls are plain expression statements, so
 * requiring that is green on this tree, and a function that genuinely needs
 * a conditional wrapper is exactly a function somebody should read and record
 * a `contract_for` case for. "It is at module scope" is not "it runs".
 */
function serveFunctionLines(file: string): number[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // The local names bound to `_lib/http.ts`'s `serveFunction`. A named import
  // may be renamed (`serveFunction as serve`), and that is still the wrapper —
  // and so is a NAMESPACE import, `import * as http from "…/_lib/http.ts"`,
  // whose `http.serveFunction(…)` the first version read as unhoused and
  // demanded a bespoke production contract for (Codex, PR #94: red on a
  // healthy tree).
  const bound = new Set<string>();
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteralLike(st.moduleSpecifier)) continue;
    if (!/(^|\/)_lib\/http\.ts$/.test(st.moduleSpecifier.text)) continue;
    const named = st.importClause?.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) {
      namespaces.add(named.name.text);
      continue;
    }
    if (!ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if ((el.propertyName ?? el.name).text === "serveFunction") bound.add(el.name.text);
    }
  }
  if (bound.size === 0 && namespaces.size === 0) return [];

  // `await x`, `(x)`, `x as T`, `x!`, `x satisfies T` and `void x` all hand
  // the same call through — `void serveFunction(handle)` still invokes the
  // wrapper unconditionally, and refusing it demanded a bespoke production
  // contract for a function that has one (Codex, PR #94: a gate red on a
  // healthy tree, which this repository calls the worse failure shape).
  const unwrap = (e: ts.Expression): ts.Expression => {
    let cur = e;
    for (let i = 0; i < 8; i += 1) {
      if (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur)
        || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)
        || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)
        || ts.isVoidExpression(cur)) cur = cur.expression;
      else return cur;
    }
    return cur;
  };
  const isWrapperCall = (e: ts.Expression | undefined): boolean => {
    if (!e) return false;
    const c = unwrap(e);
    if (!ts.isCallExpression(c)) return false;
    const callee = unwrap(c.expression);
    if (ts.isIdentifier(callee)) return bound.has(callee.text);
    // `http.serveFunction(…)` through a namespace import of the same module.
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "serveFunction" &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text)
    );
  };

  const lines: number[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  // Only the module's OWN statements. Nothing recursive: a call one level in
  // is a call whose execution depends on something this check cannot evaluate.
  for (const st of sf.statements) {
    if (ts.isExpressionStatement(st) && isWrapperCall(st.expression)) lines.push(at(st));
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (isWrapperCall(d.initializer)) lines.push(at(st));
      }
    } else if (ts.isExportAssignment(st) && isWrapperCall(st.expression)) lines.push(at(st));
  }
  return lines;
}

/**
 * Whether each shipped function is behind the house wrapper, and where.
 *
 * The ENTRYPOINT only — `index.ts`, which is what Supabase deploys and
 * evaluates. The first version accepted a call anywhere in the directory, and
 * a directory is not a request path: an unused helper beside a self-serving
 * `index.ts` made the whole function read as housed (measured). Green on the
 * healthy tree, checked rather than assumed: all fourteen real calls are
 * top-level statements in an `index.ts`, and the two functions with none are
 * the webhooks that already carry a `contract_for` case.
 *
 * A function directory with no `index.ts` is not housed, which is the safe
 * answer: Supabase has nothing to deploy for it, and the sibling assertion
 * that every directory yields a readable source file fails first and by name.
 */
function housed(
  functionsDir = join(REPO, "supabase", "functions"),
): { name: string; where: string[] }[] {
  return shippedFunctions(functionsDir).map((name) => {
    const entry = join(functionsDir, name, "index.ts");
    const where = existsSync(entry)
      ? serveFunctionLines(entry).map((line) => `${relative(functionsDir, entry)}:${line}`)
      : [];
    return { name, where };
  });
}

/**
 * The names `contract_for` actually gives a bespoke contract.
 *
 * It REFUSES rather than answering "none", because a parser that sees nothing
 * reports agreement — `column-grants.test.ts` and `db-push-check.sh` each
 * passed for exactly that reason once.
 */
function bespokeContracts(): string[] {
  const script = readFileSync(SCRIPT, "utf8");
  const block = /contract_for\(\)\s*\{[\s\S]*?case "\$1" in\n([\s\S]*?)\n\s*esac/.exec(script);
  if (!block) throw new Error(`could not find contract_for's case block in ${SCRIPT}`);
  const names = block[1].split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .flatMap((l) => {
      const m = /^\s*([^\s()|]+)\)/.exec(l);
      return m && m[1] !== "*" ? [m[1]] : [];
    });
  if (names.length === 0) throw new Error(`parsed contract_for in ${SCRIPT} and found no bespoke case`);
  return names;
}

/** The names the script's own stale-exception loop walks. Refuses likewise. */
function staleExceptionNames(): string[] {
  const m = /\n\s*for special in ([^\n;]+);\s*do/.exec(readFileSync(SCRIPT, "utf8"));
  if (!m) throw new Error(`could not find the stale-exception loop in ${SCRIPT}`);
  const names = m[1].trim().split(/\s+/).filter(Boolean);
  if (names.length === 0) throw new Error(`the stale-exception loop in ${SCRIPT} names nothing`);
  return names;
}

describe("verify-deployment: the read-only argument", () => {
  it("counts a call to the house wrapper, and not a mention of it", () => {
    // A FIXTURE rather than a floor over the real tree on purpose, in both
    // directions: "at least one function is housed" and "at least one is not"
    // are each red on a healthy change (the whole tree moving onto the wrapper
    // is exactly the change this gate should welcome). This says the detector
    // can tell the two apart at all, whatever the tree holds.
    const dir = mkdtempSync(join(tmpdir(), "serve-"));
    const put = (name: string, file: string, body: string) => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, file), body);
    };
    // Housed, the ordinary spelling.
    put("alpha", "index.ts", 'import { serveFunction } from "../_lib/http.ts";\nserveFunction((req) => handle(req));\n');
    // Housed under a renamed import — still the house wrapper.
    put("beta", "index.ts", 'import { serveFunction as serve } from "../_lib/http.ts";\nserve(handle);\n');
    // NOT housed: its own Deno.serve, the original bypass.
    put("gamma", "index.ts", 'Deno.serve((req) => new Response("ok"));\n');
    // NOT housed, and the finding that inverted this rule: an imported helper
    // serves just as much, and carries no `Deno.serve` anywhere.
    put("delta", "index.ts", 'import { serve } from "https://deno.land/std/http/server.ts";\nserve((req) => new Response("ok"));\n');
    // NOT housed: prose only. A comment in the shape four `deps.ts` files in
    // this tree really carry, plus a string. Neither runs anything.
    put("epsilon", "index.ts", '// importing index.ts executes `serveFunction` and binds a port\nconst doc = "serveFunction(handle)";\nDeno.serve(handle);\n');
    // NOT housed: a local function of the same name is not the house wrapper.
    put("zeta", "index.ts", 'const serveFunction = (h: unknown) => Deno.serve(h as never);\nserveFunction(handle);\n');
    // NOT housed: the entrypoint serves itself, and the only `serveFunction`
    // call in the directory sits in an unused helper inside a function nobody
    // invokes. A call that never runs serves nothing — Codex's case, which
    // read as housed while the wrapper was not in front of the request.
    put("eta", "index.ts", 'import { serve } from "https://deno.land/std/http/server.ts";\nserve(handle);\n');
    writeFileSync(
      join(dir, "eta", "unused.ts"),
      'import { serveFunction } from "../_lib/http.ts";\nexport function neverRuns() {\n  serveFunction(handle);\n}\n',
    );
    // NOT housed for the same reason WITHIN the entrypoint: deferred to a
    // caller this check cannot see.
    put("theta", "index.ts", 'import { serveFunction } from "../_lib/http.ts";\nexport function boot() {\n  serveFunction(handle);\n}\nDeno.serve(handle);\n');
    // NOT housed: at module scope, but CONDITIONAL. An earlier version of
    // this rule counted it, on an argument about healthy trees I had not
    // measured — and `if (false) serveFunction(handle)` reads identically.
    put("iota", "index.ts", 'import { serveFunction } from "../_lib/http.ts";\nif (Deno.env.get("MODE")) {\n  serveFunction(handle);\n}\nDeno.serve(handle);\n');
    // Codex's case, the same rule at its plainest.
    put("mu", "index.ts", 'import { serveFunction } from "../_lib/http.ts";\nimport { serve } from "https://deno.land/std/http/server.ts";\nif (false) serveFunction(handle);\nserve(handle);\n');
    // Housed: the wrapper's result kept in a module-scope binding, and the
    // awaited spelling. Both are unconditional statements of the module.
    put("nu", "index.ts", 'import { serveFunction } from "../_lib/http.ts";\nconst server = serveFunction(handle);\n');
    put("xi", "index.ts", 'import { serveFunction } from "../_lib/http.ts";\nawait serveFunction(handle);\n');
    // Housed: `void` is a transparent wrapper, not a refusal to run. The
    // spelling exists to say "I am deliberately not awaiting this".
    put("omicron", "index.ts", 'import { serveFunction } from "../_lib/http.ts";\nvoid serveFunction(handle);\n');
    put("pi", "index.ts", 'import { serveFunction } from "../_lib/http.ts";\nvoid (await serveFunction(handle));\n');
    // Housed through a NAMESPACE import of the same module.
    put("rho", "index.ts", 'import * as http from "../_lib/http.ts";\nhttp.serveFunction(handle);\n');
    // NOT housed: the same spelling on a namespace of a DIFFERENT module is
    // not the house wrapper, which is the whole point of reading the import.
    put("sigma", "index.ts", 'import * as other from "./other.ts";\nother.serveFunction(handle);\nDeno.serve(handle);\n');
    // NOT housed, and this one isolates the ENTRYPOINT rule from the
    // module-scope rule: a sibling file calls `serveFunction` at top level,
    // and nothing imports it. Written because the first version of `eta`
    // wrapped its call in a function, so the module-scope rule caught it too
    // and a sabotage of the entrypoint scoping stayed green — a broken proof,
    // not a passing one.
    put("kappa", "index.ts", 'import { serve } from "https://deno.land/std/http/server.ts";\nserve(handle);\n');
    writeFileSync(
      join(dir, "kappa", "orphan.ts"),
      'import { serveFunction } from "../_lib/http.ts";\nserveFunction(handle);\n',
    );

    const byName = Object.fromEntries(housed(dir).map((f) => [f.name, f.where.length > 0]));
    expect(byName).toEqual({
      alpha: true,
      beta: true,
      gamma: false,
      delta: false,
      epsilon: false,
      zeta: false,
      eta: false,
      theta: false,
      iota: false,
      kappa: false,
      mu: false,
      nu: true,
      xi: true,
      omicron: true,
      pi: true,
      rho: true,
      sigma: false,
    });
  });

  it("every function not behind serveFunction has a bespoke contract_for case", () => {
    const shipped = shippedFunctions();
    expect(shipped.length, "scripts/repo-functions.sh found no function directory").toBeGreaterThan(0);

    // A directory the scan reads nothing from contributes nothing and would
    // pass in silence, so it fails here by name instead.
    const unread = shipped.filter((n) => sourceFiles(join(REPO, "supabase", "functions", n)).length === 0);
    expect(unread, "function directories with no scanned source file").toEqual([]);

    const bespoke = bespokeContracts();
    const uncovered = housed()
      .filter((f) => f.where.length === 0 && !bespoke.includes(f.name))
      .map((f) => f.name);
    expect(
      uncovered,
      "functions that do not call `_lib/http.ts`'s `serveFunction` and have no `contract_for` case — they take the "
        + "DEFAULT contract, so verify-deployment.sh fires a GET at production against a function nobody has "
        + "established is read-only. Either put it behind the wrapper, or read it and record the contract.",
    ).toEqual([]);
  });

  it("the script's stale-exception loop covers every bespoke contract", () => {
    // `for special in …` is a SECOND enumeration of the same set: it is what
    // makes a `contract_for` case naming a function the repo no longer ships
    // fatal. A case added to one and not the other leaves that check quietly
    // not covering it — one rule, two scopes, which is the disagreement this
    // repository keeps paying for. Fails in both directions.
    expect([...staleExceptionNames()].sort()).toEqual([...bespokeContracts()].sort());
  });
});
