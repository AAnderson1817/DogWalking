import { execFile, execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/staging-fixtures.sh` is the fixture housekeeping both replay steps
 * in `staging-smoke.yml` source. It exists as a file rather than as bash inside
 * the workflow for the reason `check-auth-posture.sh` does: inline in YAML
 * nothing can exercise it, and these rules were each written after a real
 * failure that a test would have caught.
 *
 * The steps themselves are driven here too, extracted from the real workflow
 * with the same YAML parser `scripts/verify-workflows.py` uses. A correct
 * library the workflow does not actually source would be this repository's
 * most-recorded defect — a rule written down and connected to nothing — so the
 * cases below run the shipped `run:` block, not a paraphrase of it.
 *
 * The stub pages and refuses the way the real APIs do: GoTrue caps `per_page`,
 * a create collides with 422 when the address is still taken, and a REST delete
 * refused by a foreign key answers 409.
 */

const REPO = resolve(__dirname, "..", "..");
const WORKFLOW = join(REPO, ".github", "workflows", "staging-smoke.yml");
const JOB = "onboard-repro";
/** Matched on an ASCII prefix: the onboard step's full name carries a `→`, and
 * comparing argv across a locale boundary is a way to match nothing quietly. */
const ONBOARD = "Replay onboard";
const CLAIM = "Replay invite-claim";
const RUN_ID = "555";
const RUN_ATTEMPT = "2";
const ONBOARD_EMAIL = `diag-onboard-${RUN_ID}-${RUN_ATTEMPT}@sanpo.test`;
const CLAIM_OP_EMAIL = `diag-claim-op-${RUN_ID}-${RUN_ATTEMPT}@sanpo.test`;
const CLAIM_CLIENT_EMAIL = `diag-claim-client-${RUN_ID}-${RUN_ATTEMPT}@sanpo.test`;
const INVITE = "11111111-2222-4333-8444-555555555555";
const CLIENT_ROW = "cccccccc-2222-4333-8444-555555555555";

// ── the stub ────────────────────────────────────────────────────────────────

type User = { id: string; email: string };

type StubOpts = {
  /** how many filler auth users the project holds (GoTrue serves 100 a page) */
  fill?: number;
  /** addresses already present, at the index given — 250 lands on page 3 */
  seeded?: { email: string; at: number }[];
  /** addresses the create refuses with 422 even though the list never shows them */
  alsoTaken?: string[];
  /** HTTP status for GET admin/users, by page */
  listStatusFor?: (page: number) => number;
  /** serve page 1 forever, the way an endpoint that ignores `page` would */
  ignorePage?: boolean;
  /** HTTP status for a DELETE, by path */
  deleteStatusFor?: (path: string) => number;
};

type StubState = {
  base: string;
  users: User[];
  /** every page number GET admin/users was asked for, in order */
  pages: number[];
  /** every DELETE path, in order */
  deletes: string[];
  /** every address POST admin/users was asked to create */
  creates: string[];
};

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function body(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => done(text));
  });
}

async function stub(opts: StubOpts = {}): Promise<StubState> {
  const fill = opts.fill ?? 350;
  const users: User[] = Array.from({ length: fill }, (_, i) => ({
    id: `filler-${i}`,
    email: `filler-${i}@sanpo.test`,
  }));
  for (const { email, at } of opts.seeded ?? []) {
    users[at] = { id: `leftover-${at}`, email };
  }
  const alsoTaken = new Set(opts.alsoTaken ?? []);
  const state: StubState = { base: "", users, pages: [], deletes: [], creates: [] };
  let nextId = 0;

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const path = url.pathname;
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };

    // ── GoTrue admin ──────────────────────────────────────────────────────
    if (path === "/auth/v1/admin/users" && req.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      state.pages.push(page);
      const status = opts.listStatusFor?.(page) ?? 200;
      if (status !== 200) return send(status, { msg: "nope" });
      // GoTrue caps the page size. A caller asking for more gets 100, which is
      // what makes "a short page means the last page" the wrong stop rule.
      const perPage = Math.min(Number(url.searchParams.get("per_page") ?? "50"), 100);
      const at = opts.ignorePage ? 0 : (page - 1) * perPage;
      return send(200, { users: state.users.slice(at, at + perPage) });
    }
    if (path === "/auth/v1/admin/users" && req.method === "POST") {
      void body(req).then((text) => {
        const email = String(JSON.parse(text || "{}").email ?? "");
        state.creates.push(email);
        if (state.users.some((u) => u.email === email) || alsoTaken.has(email)) {
          return send(422, { msg: "A user with this email address has already been registered" });
        }
        const user = { id: `created-${nextId++}`, email };
        state.users.push(user);
        send(200, user);
      });
      return;
    }
    const oneUser = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(path);
    if (oneUser && req.method === "DELETE") {
      state.deletes.push(`${path}${url.search}`);
      const status = opts.deleteStatusFor?.(path) ?? 204;
      if (status < 300) state.users = state.users.filter((u) => u.id !== oneUser[1]);
      return send(status, {});
    }
    if (oneUser && req.method === "PUT") return send(200, { id: oneUser[1] });
    if (path === "/auth/v1/token") return send(200, { access_token: "stub-access-token" });

    // ── PostgREST ─────────────────────────────────────────────────────────
    if (req.method === "DELETE") {
      state.deletes.push(`${path}${url.search}`);
      return send(opts.deleteStatusFor?.(path) ?? 204, {});
    }
    if (path === "/rest/v1/operators" && req.method === "POST") {
      void body(req).then((text) => send(201, [{ id: String(JSON.parse(text || "{}").id ?? "") }]));
      return;
    }
    if (path === "/rest/v1/operators") {
      const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
      return send(200, [{ id }]);
    }
    if (path === "/rest/v1/service_types") return send(200, [{ name: "Walk" }, { name: "Visit" }]);
    if (path === "/rest/v1/clients" && req.method === "POST") {
      return send(201, [{ id: CLIENT_ROW, invite_token: INVITE }]);
    }
    if (path === "/rest/v1/clients") return send(200, [{ id: CLIENT_ROW, status: "active" }]);
    if (path.startsWith("/rest/v1/rpc/")) return send(200, { outcome: "claimed" });

    // ── edge functions ────────────────────────────────────────────────────
    if (path === "/functions/v1/claim-signup") {
      void body(req).then((text) => {
        const payload = JSON.parse(text || "{}");
        if (String(payload.token) !== INVITE) {
          return send(409, { ok: false, error: { code: "not_found" } });
        }
        state.users.push({ id: `claimed-${nextId++}`, email: String(payload.email) });
        send(200, { ok: true });
      });
      return;
    }

    send(404, { msg: `stub has no route for ${req.method} ${path}` });
  });

  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  state.base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  return state;
}

// ── running shell the way GitHub does ───────────────────────────────────────

/** `bash -e {0}` is GitHub's default `shell` on Linux: -e, and no pipefail. */
function runShell(
  text: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "smoke-step-"));
  const file = join(dir, "step.sh");
  writeFileSync(file, text);
  return new Promise((done) => {
    execFile(
      "bash",
      ["-e", file],
      {
        cwd: REPO,
        encoding: "utf8",
        env: {
          ...process.env,
          SERVICE_KEY: "stub-service-key",
          ANON_KEY: "stub-anon-key",
          GITHUB_RUN_ID: RUN_ID,
          GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
          ...env,
          // A stub on 127.0.0.1 must not be routed through an egress proxy.
          http_proxy: "",
          https_proxy: "",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          NO_PROXY: "127.0.0.1,localhost",
        },
      },
      (err, stdout, stderr) => {
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` });
      },
    );
  });
}

/** Source the library and run one snippet against it. */
function runLib(base: string, snippet: string, env: Record<string, string> = {}) {
  return runShell(`. ./scripts/staging-fixtures.sh "${base}"\n${snippet}\n`, env);
}

// ── reading a step out of the workflow ──────────────────────────────────────

const EXTRACT = `
import sys, yaml
doc = yaml.safe_load(open(sys.argv[1], encoding="utf-8").read())
job = (doc.get("jobs") or {}).get(sys.argv[2])
if job is None:
    raise SystemExit("no job %r in %s" % (sys.argv[2], sys.argv[1]))
hits = [s for s in (job.get("steps") or []) if str(s.get("name") or "").startswith(sys.argv[3])]
if len(hits) != 1:
    raise SystemExit("expected one step whose name starts %r, found %d" % (sys.argv[3], len(hits)))
run = hits[0].get("run") or ""
if not run.strip():
    raise SystemExit("that step has no run: block")
sys.stdout.buffer.write(run.encode("utf-8"))
`;

/** The step's real `run:` block, read with the parser `verify-workflows.py`
 * uses. Bytes, not text: the blocks carry em dashes, and a C locale would
 * refuse to encode them on the way out of python. */
function stepRun(namePrefix: string): string {
  return execFileSync("python3", ["-c", EXTRACT, WORKFLOW, JOB, namePrefix], {
    encoding: "buffer",
  }).toString("utf8");
}

const PROJECT_URL = "https://${{ secrets.SUPABASE_PROJECT_REF }}.supabase.co";

/** Point the step at the stub. Actions expands `${{ }}` before the shell ever
 * sees it, so the harness has to do the same — and assert it hit something,
 * since a substitution that matched nothing would leave the step talking to a
 * URL that does not resolve and every assertion below would be about curl
 * failing rather than about the step. */
function stepAgainst(namePrefix: string, base: string): string {
  const run = stepRun(namePrefix);
  expect(run.split(PROJECT_URL).length - 1).toBe(1);
  const text = run.split(PROJECT_URL).join(base);
  expect(text).not.toContain("${{");
  return text;
}

// ── the library ─────────────────────────────────────────────────────────────

describe("scripts/staging-fixtures.sh", () => {
  it("finds an address on page 3 of 350 auth users", async () => {
    const s = await stub({ seeded: [{ email: ONBOARD_EMAIL, at: 250 }] });
    const { code, out } = await runLib(s.base, `user_id_for "${ONBOARD_EMAIL}"`);
    expect(code).toBe(0);
    expect(out).toBe("leftover-250");
    // Not a vacuous pass: it really paged, and stopped when it had the answer.
    expect(s.pages).toEqual([1, 2, 3]);
  });

  it("reports a genuinely absent address as absent, stopping at the first empty page", async () => {
    // 250 users: pages of 100, 100, 50, then an empty one. The SHORT third
    // page is the trap — the rule is "stop on an empty page, never on a short
    // one", and a reader that stopped at three would report absence having
    // never looked past the cap.
    const s = await stub({ fill: 250 });
    const { code, out } = await runLib(s.base, `user_id_for "nobody@sanpo.test"`);
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(s.pages).toEqual([1, 2, 3, 4]);
  });

  // ── the transport failure, at all three capture sites ────────────────────
  //
  // `bash -e` — which is what a GitHub Actions `run:` step uses — exits at the
  // ASSIGNMENT when a command substitution's command fails, so
  // `code=$(admin …)` used to kill the whole step before the `case` or the
  // `::error` beneath it could say anything. Reproduced against an unreachable
  // origin: exit 7, no annotation, and the deletes after it never ran. These
  // three cases are one per capture site rather than one for the site Codex
  // named, because they had the identical shape.
  //
  // Port 9 is the discard service and nothing listens on it here, so the
  // connection is refused immediately — a real transport failure, not a
  // timeout the suite would have to wait out.
  const DEAD = "http://127.0.0.1:9";

  it("cleanup survives a transport failure, warns, and keeps deleting", async () => {
    const { code, out } = await runLib(
      DEAD,
      `del "${DEAD}/rest/v1/clients?id=eq.1" "first"\ndel "${DEAD}/rest/v1/clients?id=eq.2" "second"\necho REACHED-THE-END`,
    );
    expect(code).toBe(0);
    // BOTH deletes ran: the point of the fix is that one failure does not take
    // the rest of cleanup, and the step, with it.
    expect(out).toContain("DELETE first did not complete");
    expect(out).toContain("DELETE second did not complete");
    expect(out).toContain("REACHED-THE-END");
    expect(out).toContain("::warning");
  });

  it("a lookup that cannot be sent is a failed lookup, never an absence", async () => {
    const { code, out } = await runLib(DEAD, `user_id_for "${ONBOARD_EMAIL}"`);
    // 9, not 0-with-empty-stdout. The dead-token security assertion in the
    // claim replay reads this return value.
    expect(code).toBe(9);
    expect(out).toContain("did not complete");
  });

  it("a create that cannot be sent says so, rather than dying unexplained", async () => {
    const { code, out } = await runLib(DEAD, `create_fixture_user "${ONBOARD_EMAIL}" "pw-Aa123456789"`);
    expect(code).not.toBe(0);
    expect(out).toContain("::error");
    expect(out).toContain("did not complete");
    // The distinction that makes the annotation worth printing: unreachable is
    // not the same as refused, and the old code could say neither.
    expect(out).toContain("staging was unreachable, not refusing");
  });

  it("exits 9 on a failed lookup rather than answering 'absent'", async () => {
    // The distinction two security assertions in the claim replay depend on: a
    // 401 read as "no such account" passes the dead-token check while checking
    // nothing.
    const s = await stub({ listStatusFor: (p) => (p === 2 ? 401 : 200) });
    const { code, out } = await runLib(s.base, `user_id_for "${ONBOARD_EMAIL}"`);
    expect(code).toBe(9);
    expect(out).toContain("auth user lookup failed: GET admin/users page 2 -> HTTP 401");
  });

  it("stops when the server ignores `page` instead of scanning to the bound", async () => {
    const s = await stub({ ignorePage: true });
    const { code, out } = await runLib(s.base, `user_id_for "nobody@sanpo.test"`);
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(s.pages).toEqual([1, 2]);
  });

  it("reports a refused delete as a warning and stays non-fatal", async () => {
    const s = await stub({ deleteStatusFor: () => 409 });
    const { code, out } = await runLib(
      s.base,
      `del "${"$STAGING_BASE"}/rest/v1/operators?id=eq.op-1" "operator op-1"\necho DONE`,
    );
    expect(code).toBe(0);
    expect(out).toContain("::warning title=Fixture cleanup left something behind::");
    expect(out).toContain("DELETE operator op-1 -> HTTP 409");
    expect(out).toContain("DONE");
  });

  it("says nothing when a delete succeeds", async () => {
    const s = await stub({});
    const { code, out } = await runLib(
      s.base,
      `del "${"$STAGING_BASE"}/rest/v1/operators?id=eq.op-1" "operator op-1"`,
    );
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(s.deletes).toEqual(["/rest/v1/operators?id=eq.op-1"]);
  });

  it("creates a fixture user and hands back its id", async () => {
    const s = await stub({ fill: 0 });
    const { code, out } = await runLib(
      s.base,
      `create_fixture_user "${ONBOARD_EMAIL}" "pw" && echo "uid=$FIXTURE_UID"`,
    );
    expect(code).toBe(0);
    expect(out).toContain("uid=created-0");
    expect(s.creates).toEqual([ONBOARD_EMAIL]);
  });

  it("names the status, the provider's message and the broken half on a 422", async () => {
    // The leftover is visible to the lookup, so the DELETE is what failed.
    const s = await stub({ seeded: [{ email: ONBOARD_EMAIL, at: 250 }] });
    const { code, out } = await runLib(s.base, `create_fixture_user "${ONBOARD_EMAIL}" "pw"`);
    expect(code).toBe(1);
    expect(out).toContain("HTTP 422 — A user with this email address has already been registered");
    expect(out).toContain("::error title=Cleanup did not delete the leftover::");
    expect(out).toContain("leftover-250");
  });

  it("names the SEARCH when a 422 address is one the lookup cannot see", async () => {
    const s = await stub({ fill: 10, alsoTaken: [ONBOARD_EMAIL] });
    const { code, out } = await runLib(s.base, `create_fixture_user "${ONBOARD_EMAIL}" "pw"`);
    expect(code).toBe(1);
    expect(out).toContain("::error title=The lookup cannot see the leftover::");
  });

  it("says so when the 422 diagnosis cannot be made at all", async () => {
    const s = await stub({ fill: 10, alsoTaken: [ONBOARD_EMAIL], listStatusFor: () => 503 });
    const { code, out } = await runLib(s.base, `create_fixture_user "${ONBOARD_EMAIL}" "pw"`);
    expect(code).toBe(1);
    expect(out).toContain("::error title=Could not tell which half is broken::");
  });

  it("refuses to be sourced without a base URL", async () => {
    const { code, out } = await runShell(`. ./scripts/staging-fixtures.sh\necho REACHED`);
    expect(code).not.toBe(0);
    expect(out).toContain("source it with the project base URL");
    expect(out).not.toContain("REACHED");
  });

  it("refuses to be sourced without a service key", async () => {
    const { code, out } = await runShell(
      `. ./scripts/staging-fixtures.sh "http://127.0.0.1:1"\necho REACHED`,
      { SERVICE_KEY: "" },
    );
    expect(code).not.toBe(0);
    expect(out).toContain("SERVICE_KEY is unset");
    expect(out).not.toContain("REACHED");
  });
});

// ── the workflow asks for it ────────────────────────────────────────────────

describe("staging-smoke.yml", () => {
  const steps = () => [stepRun(ONBOARD), stepRun(CLAIM)];

  it("sources the library from both replay steps", () => {
    for (const run of steps()) expect(run).toContain(". ./scripts/staging-fixtures.sh");
  });

  it("checks the repository out, or the source cannot resolve", () => {
    const uses = execFileSync(
      "python3",
      [
        "-c",
        `
import sys, yaml
doc = yaml.safe_load(open(sys.argv[1], encoding="utf-8").read())
for s in doc["jobs"][sys.argv[2]]["steps"]:
    print(str(s.get("uses") or ""))
`,
        WORKFLOW,
        JOB,
      ],
      { encoding: "utf8" },
    );
    expect(uses).toContain("actions/checkout@");
  });

  it("keeps no second copy of the helpers", () => {
    // The defect this whole change is about was two copies of the same four
    // rules, one of them three fixes behind. A re-inlined definition is that
    // state again, so it fails here rather than in six months.
    for (const run of steps()) {
      for (const fn of ["user_id_for()", "del()", "admin()", "create_fixture_user()"]) {
        expect(run).not.toContain(fn);
      }
      expect(run).not.toContain("page=1&per_page=100");
      expect(run).not.toMatch(/-X DELETE[^\n]*\|\| true/);
    }
  });
});

// ── the steps themselves, end to end ────────────────────────────────────────

describe("the replay steps, driven against a stub", () => {
  it("onboard: finds last run's leftover on page 3, deletes it, and completes", async () => {
    const s = await stub({ seeded: [{ email: ONBOARD_EMAIL, at: 250 }] });
    const { code, out } = await runShell(stepAgainst(ONBOARD, s.base));
    expect(out).toContain("fixture user: created-0");
    expect(code).toBe(0);
    // The leftover was searched for past page 1 and then actually removed —
    // without both, the create below collides with it and the job dies on a
    // 422 whose cause is a run that finished a fortnight ago.
    expect(s.pages.slice(0, 3)).toEqual([1, 2, 3]);
    expect(s.deletes).toContain("/auth/v1/admin/users/leftover-250");
    expect(s.deletes).toContain("/rest/v1/operators?id=eq.leftover-250");
    expect(s.deletes).toContain("/rest/v1/service_types?operator_id=eq.leftover-250");
    expect(s.creates).toEqual([ONBOARD_EMAIL]);
  });

  it("onboard: completes with nothing to clean up, which is every ordinary run", async () => {
    // The common path, and the one a regression here would break on every
    // staging deploy: no leftover, so the lookup answers empty and cleanup has
    // nothing to do.
    const s = await stub({});
    const { code, out } = await runShell(stepAgainst(ONBOARD, s.base));
    expect(out).toContain("fixture user: created-0");
    expect(out).not.toContain("::warning");
    expect(code).toBe(0);
    // Only the EXIT trap's three deletes, for the fixture this run created.
    expect(s.deletes.filter((d) => d.includes("leftover"))).toEqual([]);
  });

  it("onboard: names the status, the message and the broken half when it cannot start", async () => {
    // Cleanup refused everything, so the create collides. Before this commit
    // the entire diagnosis was `FAIL: could not create fixture user`.
    const s = await stub({
      seeded: [{ email: ONBOARD_EMAIL, at: 250 }],
      deleteStatusFor: () => 409,
    });
    const { code, out } = await runShell(stepAgainst(ONBOARD, s.base));
    expect(code).not.toBe(0);
    expect(out).toContain("HTTP 422 — A user with this email address has already been registered");
    expect(out).toContain("::error title=Cleanup did not delete the leftover::");
    expect(out).not.toContain("FAIL: could not create fixture user");
  });

  it("onboard: reports a refused cleanup delete instead of swallowing it", async () => {
    // Only the operators delete is refused, so this case is about the
    // reporting and nothing else.
    const s = await stub({
      seeded: [{ email: ONBOARD_EMAIL, at: 250 }],
      deleteStatusFor: (p) => (p === "/rest/v1/operators" ? 409 : 204),
    });
    const { code, out } = await runShell(stepAgainst(ONBOARD, s.base));
    expect(out).toContain("::warning title=Fixture cleanup left something behind::");
    expect(out).toContain("DELETE operator leftover-250 -> HTTP 409");
    expect(code).toBe(0);
  });

  it("claim: still replays end to end after the extraction", async () => {
    const s = await stub({ seeded: [{ email: CLAIM_OP_EMAIL, at: 250 }] });
    const { code, out } = await runShell(stepAgainst(CLAIM, s.base));
    expect(out).toContain("claim-signup (dead token) -> HTTP 409");
    expect(out).toContain("fn_claim_invite -> HTTP 200");
    expect(code).toBe(0);
    expect(s.deletes).toContain("/auth/v1/admin/users/leftover-250");
    // The client account is created by claim-signup and by nothing else — the
    // replay never asks the admin API for it — and the EXIT trap takes it away
    // again, which is why the evidence is the delete rather than a surviving
    // row.
    expect(s.creates).toEqual([CLAIM_OP_EMAIL]);
    expect(s.deletes.filter((d) => d.startsWith("/auth/v1/admin/users/claimed-"))).toHaveLength(1);
    expect(s.users.some((u) => u.email === CLAIM_CLIENT_EMAIL)).toBe(false);
  });
});
