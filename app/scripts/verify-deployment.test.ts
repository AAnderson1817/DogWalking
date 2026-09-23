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
  if (ts.isComputedPropertyName(name)) return literalText(name.expression) ?? UNREADABLE;
  return name.text;
}

type Access = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/** The member an access names — `a.b`, `a["b"]`, `` a[`b`] `` — or UNREADABLE. */
function memberOf(e: Access): string | typeof UNREADABLE {
  return ts.isPropertyAccessExpression(e) ? e.name.text : literalText(e.argumentExpression) ?? UNREADABLE;
}

/** An expression with the wrappers that change nothing at run time removed. */
function unwrap(value: ts.Expression): ts.Expression {
  let e = value;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)
    || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
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
  const options = call.arguments[1];
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
 * options are out of sight (an alias, a renaming import); and a member of
 * `Deno` the scan cannot read could be `serve`. What stays outside: a second
 * serve reached through a name the scan never sees at all (`const { serve } =
 * Deno`, an alias of `Deno` itself) beside a first one it does — one serve
 * per function is the shape the runtime runs, and the fallback covers it.
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
        const access = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node : undefined;
        const member = access && memberOf(access);
        if (access && ts.isIdentifier(access.expression) && access.expression.text === "Deno") {
          if (member === "serve") door("its own Deno.serve");
          else if (member === UNREADABLE) door("a member of Deno the scan cannot read");
        }
        const namesServeFunction = (ts.isIdentifier(node) && node.text === "serveFunction") || member === "serveFunction";
        if (namesServeFunction) {
          const parent = node.parent;
          if (ts.isCallExpression(parent) && parent.expression === node) {
            serves = true;
            const why = widening(parent);
            if (why) found.set(name, why);
          } else if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
            // `import { serveFunction }` names it without calling it; renamed,
            // every call is under a name the scan does not look for.
            if (parent.propertyName) door("serveFunction imported under another name, so the scan cannot see its calls");
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
    expect(Object.fromEntries(getReachable(root))).toEqual({
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
    // Not doors: other members of Deno, read the ordinary way.
    fn("deno-env", 'serveFunction(h);\nconst url = Deno.env.get("SUPABASE_URL");');
    expect(Object.fromEntries(getReachable(root))).toEqual({
      namespace: "serveFunction widened with methods",
      element: "serveFunction widened with methods",
      alias: "serveFunction referenced without being called, so the scan cannot see its options",
      renamed: "serveFunction imported under another name, so the scan cannot see its calls",
      "deno-element": "its own Deno.serve",
      "deno-template": "its own Deno.serve",
      "deno-unreadable": "a member of Deno the scan cannot read",
      "deno-alias": "its own Deno.serve",
    });
  });
});
