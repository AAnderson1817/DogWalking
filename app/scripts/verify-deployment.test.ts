import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
// functions it applies to. A sentence is not a gate: a third function with
// its own `Deno.serve` silently gets the DEFAULT contract, nobody is asked
// whether a GET is safe against it, and the probe finds out by making the
// request. So the requirement is DERIVED here — every self-serving function
// must have a bespoke case — and it is a test rather than a runtime check in
// the script because CI runs this on every push while the deploy that runs
// the script is gated on CI being green, so a bypasser with no case cannot
// reach a deploy without going red first.
//
// PARSED, not grepped, and the reason is measurable: `platform-webhook`'s own
// header says "Same bare Deno.serve shape as stripe-webhook", so a grep over
// that file counts a COMMENT. Today it counts the right function anyway; the
// day a function that does NOT serve itself mentions the name in prose, a
// grep makes this gate red on a healthy tree, which this repository records
// as the worst shape a gate can take. A comment is not an AST node.
//
// Stated rather than chased, on the stopping rule the enum-catalogue
// generator writes down: this catches the mistake, not the adversary.
// `globalThis["De" + "no"].serve(…)` is not detected, and nothing in this
// tree writes anything of the kind.

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
 * The lines where a file's CODE names `Deno.serve` (either spelling).
 *
 * A REFERENCE, not only a call: `const s = Deno.serve; s(handler)` serves
 * exactly as much, and naming it is the only reason to write it.
 */
function denoServeLines(file: string): number[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines: number[] = [];
  const isDeno = (e: ts.Expression) => ts.isIdentifier(e) && e.text === "Deno";
  const visit = (n: ts.Node) => {
    const hit = (ts.isPropertyAccessExpression(n) && n.name.text === "serve" && isDeno(n.expression))
      || (ts.isElementAccessExpression(n) && isDeno(n.expression)
        && ts.isStringLiteralLike(n.argumentExpression)
        && n.argumentExpression.text === "serve");
    if (hit) lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

/** The functions that serve themselves, and where each says so. */
function selfServing(
  functionsDir = join(REPO, "supabase", "functions"),
): { name: string; where: string[] }[] {
  return shippedFunctions(functionsDir).flatMap((name) => {
    const where = sourceFiles(join(functionsDir, name))
      .flatMap((f) => denoServeLines(f).map((line) => `${relative(functionsDir, f)}:${line}`));
    return where.length > 0 ? [{ name, where }] : [];
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
  it("sees a bypass written in code, and not one written in prose", () => {
    // The precondition, and it is a FIXTURE rather than a floor over the real
    // tree on purpose: "at least one function serves itself" would go red the
    // day both webhooks move onto `serveFunction`, which is a healthy change.
    // This says the detector can see a bypass at all, whatever the tree holds.
    const dir = mkdtempSync(join(tmpdir(), "serve-"));
    const put = (name: string, file: string, body: string) => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, file), body);
    };
    put("alpha", "index.ts", 'Deno.serve((req) => new Response("ok"));\n');
    put("beta", "index.ts", 'import { serveFunction } from "../_lib/http.ts";\nserveFunction((req) => handle(req));\n');
    // Prose only: a comment in the shape `platform-webhook/index.ts:6` really
    // carries, and a string. Neither runs anything.
    put("gamma", "index.ts", '// Same bare Deno.serve shape as stripe-webhook.\nconst doc = "Deno.serve";\nserveFunction(handle);\n');
    // Not the entrypoint, and not a call — a reference handed to a variable.
    put("delta", "index.ts", 'import { boot } from "./boot.ts";\nboot();\n');
    writeFileSync(join(dir, "delta", "boot.ts"), 'export const boot = () => {\n  const s = Deno["serve"];\n  s(handle);\n};\n');

    expect(selfServing(dir).map((f) => f.name)).toEqual(["alpha", "delta"]);
  });

  it("every function with its own Deno.serve has a bespoke contract_for case", () => {
    const shipped = shippedFunctions();
    expect(shipped.length, "scripts/repo-functions.sh found no function directory").toBeGreaterThan(0);

    // A directory the scan reads nothing from contributes nothing and would
    // pass in silence, so it fails here by name instead.
    const unread = shipped.filter((n) => sourceFiles(join(REPO, "supabase", "functions", n)).length === 0);
    expect(unread, "function directories with no scanned source file").toEqual([]);

    const bespoke = bespokeContracts();
    const uncovered = selfServing()
      .filter((f) => !bespoke.includes(f.name))
      .map((f) => `${f.name} (${f.where.join(", ")})`);
    expect(
      uncovered,
      "functions with their own `Deno.serve` and no `contract_for` case — they take the DEFAULT contract, "
        + "so verify-deployment.sh fires a GET at production against a function nobody has established is read-only",
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
