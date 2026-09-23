import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/staging-fixtures.sh` — the throwaway-fixture helpers both staging
 * smoke replays source — driven against a stub of GoTrue's admin API and
 * PostgREST.
 *
 * Each rule below was learnt on the invite-claim replay one failure at a time
 * and proven against a stub in a session scratchpad, which is a rule connected
 * to nothing once the container is gone; meanwhile the onboard replay kept the
 * inline versions it had been cured of (spec-drift audit). This is where they
 * are proven now, for both.
 */

const REPO = resolve(__dirname, "..", "..");
const LIB = join(REPO, "scripts", "staging-fixtures.sh");

interface Stub {
  /** users GoTrue holds, in its order */
  users?: { id: string; email: string }[];
  /** GoTrue caps per_page; it caps at 100 */
  cap?: number;
  /** answer every admin/users GET with this status instead */
  listStatus?: number;
  /** answer admin/users GETs with a body carrying no users array */
  listBodyless?: boolean;
  /** ignore `page`, always answering page 1 */
  ignorePage?: boolean;
  /** POST admin/users answer */
  create?: { status: number; body: unknown };
  /** DELETE answers, by path prefix; default 204 */
  deletes?: Record<string, number>;
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function stub(s: Stub): Promise<{ base: string; requests: string[] }> {
  const requests: string[] = [];
  const users = s.users ?? [];
  const cap = s.cap ?? 100;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/auth/v1/admin/users") {
      if (s.listStatus) return json(s.listStatus, { msg: "Invalid API key" });
      if (s.listBodyless) return json(200, { msg: "ok" });
      const per = Math.min(Number(url.searchParams.get("per_page") ?? 50), cap);
      const page = s.ignorePage ? 1 : Number(url.searchParams.get("page") ?? 1);
      return json(200, { users: users.slice((page - 1) * per, page * per) });
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/admin/users") {
      const c = s.create ?? { status: 200, body: { id: "new-user-id" } };
      // A string is sent as it is — a gateway's HTML error page is not JSON.
      if (typeof c.body === "string") {
        res.writeHead(c.status, { "content-type": "text/html" });
        res.end(c.body);
        return;
      }
      return json(c.status, c.body);
    }
    if (req.method === "DELETE") {
      const status = Object.entries(s.deletes ?? {}).find(([p]) => url.pathname.startsWith(p))?.[1] ?? 204;
      res.writeHead(status).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  const port = (server!.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, requests };
}

/**
 * Sources the library under `bash -e -o pipefail` — how Actions runs a step —
 * and runs `script`. Async, because the stub lives in this process: a
 * synchronous exec would block the event loop and hang the first curl
 * (verify-deployment.test.ts learnt that).
 */
function sh(base: string, script: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    execFile(
      "bash",
      ["-e", "-o", "pipefail", "-c", `base="${base}"; . "${LIB}"; ${script}`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SERVICE_KEY: "stub-service-key",
          http_proxy: "",
          https_proxy: "",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          NO_PROXY: "127.0.0.1,localhost",
        },
      },
      (e, stdout, stderr) => done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr }),
    );
  });
}

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `u-${i}`, email: `someone-${i}@sanpo.test` }));

describe("user_id_for", () => {
  it("finds a user past page 1 when GoTrue caps the page size", async () => {
    const users = [...many(250), { id: "target", email: "diag-onboard-1-1@sanpo.test" }];
    const { base } = await stub({ users, cap: 100 });
    const r = await sh(base, 'user_id_for "diag-onboard-1-1@sanpo.test"');
    expect(r).toMatchObject({ code: 0, out: "target" });
  });

  it("answers empty, and succeeds, when the address is genuinely absent", async () => {
    const { base, requests } = await stub({ users: many(120) });
    const r = await sh(base, 'user_id_for "nobody@sanpo.test"; echo "[exit $?]"');
    expect(r.out).toBe("[exit 0]\n");
    // It read to the empty page, not just the first one.
    expect(requests.filter((q) => q.startsWith("GET")).length).toBe(3);
  });

  it("exits 9 when the lookup is refused, rather than reporting absence", async () => {
    const { base } = await stub({ listStatus: 401 });
    const r = await sh(base, 'rc=0; user_id_for "x@sanpo.test" || rc=$?; echo "[exit $rc]"');
    expect(r.out).toContain("[exit 9]");
    expect(r.err).toContain("HTTP 401");
  });

  it("exits 9 on a body with no users array", async () => {
    const { base } = await stub({ listBodyless: true });
    const r = await sh(base, 'rc=0; user_id_for "x@sanpo.test" || rc=$?; echo "[exit $rc]"');
    expect(r.out).toContain("[exit 9]");
  });

  it("exits 9 when the connection itself fails, even with -e inside the substitution", async () => {
    // Port 1 refuses: curl exits non-zero. Bash applies `-e` inside `$(…)`
    // only with `inherit_errexit`, and not at all on the left of `||` — so the
    // call is bare and the option on, the one arrangement in which the status
    // capture's `|| true` decides the outcome: without it the step dies with
    // curl's 7 and says nothing; with it, with 9 and the reason.
    const r = await sh("http://127.0.0.1:1", 'shopt -s inherit_errexit; id=$(user_id_for "x@sanpo.test")');
    expect(r.code).toBe(9);
    expect(r.err).toContain("HTTP 000");
  });

  it("exits 9 when the server ignores `page`, rather than rescanning or reporting absence", async () => {
    // Only page 1 was ever searched, so "absent" would be a guess — and the
    // claim replay's dead-token check reads absence as its pass (Codex, #97).
    const { base, requests } = await stub({ users: many(100), ignorePage: true });
    const r = await sh(base, 'rc=0; user_id_for "nobody@sanpo.test" || rc=$?; echo "[exit $rc]"');
    expect(r.out).toBe("[exit 9]\n");
    expect(r.err).toContain("page 2 repeated page 1");
    expect(requests.filter((q) => q.startsWith("GET")).length).toBe(2);
  });

  it("exits 9 when it runs out of pages before reaching the end", async () => {
    // The bound stops a huge user table spinning here forever. Reaching it
    // means the search did not finish, which is not the same as absent.
    const { base, requests } = await stub({ users: many(5100) });
    const r = await sh(base, 'rc=0; user_id_for "nobody@sanpo.test" || rc=$?; echo "[exit $rc]"');
    expect(r.out).toBe("[exit 9]\n");
    expect(r.err).toContain("50 pages");
    expect(requests.filter((q) => q.startsWith("GET")).length).toBe(50);
  });
});

describe("del and delete_operator", () => {
  it("say nothing when the delete succeeds", async () => {
    const { base, requests } = await stub({});
    const r = await sh(base, 'delete_operator "op-1"');
    expect(r).toMatchObject({ code: 0, out: "" });
    expect(requests).toEqual([
      "DELETE /rest/v1/service_types?operator_id=eq.op-1",
      "DELETE /rest/v1/operators?id=eq.op-1",
      "DELETE /auth/v1/admin/users/op-1",
    ]);
  });

  it("report a refused delete as a warning, and carry on", async () => {
    const { base } = await stub({ deletes: { "/rest/v1/operators": 409 } });
    const r = await sh(base, 'delete_operator "op-1"; echo "[after]"');
    expect(r.code).toBe(0);
    expect(r.out).toContain("::warning title=Fixture cleanup left something behind::DELETE operator op-1 -> HTTP 409");
    expect(r.out).toContain("[after]");
  });

  it("report an unreachable API as a warning instead of aborting the step", async () => {
    // Called as a plain command under `bash -e`, as the onboard replay's
    // cleanup is: without `|| true` on the status capture, curl's exit from
    // the refused port would end the step here, with nothing reported.
    const r = await sh("http://127.0.0.1:1", 'delete_operator "op-1"; echo "[after]"');
    expect(r.code).toBe(0);
    expect(r.out).toContain("DELETE service_types of op-1 -> HTTP 000");
    expect(r.out).toContain("[after]");
  });

  it("do nothing at all for an empty id", async () => {
    const { base, requests } = await stub({});
    await sh(base, 'delete_operator ""');
    expect(requests).toEqual([]);
  });
});

describe("create_user", () => {
  it("prints the new id and nothing else on stdout", async () => {
    const { base } = await stub({ create: { status: 200, body: { id: "fresh" } } });
    const r = await sh(base, 'uid=$(create_user "a@sanpo.test" "pw"); echo "[$uid]"');
    expect(r.out).toBe("[fresh]\n");
  });

  it("names GoTrue's own refusal instead of a bare failure", async () => {
    const { base } = await stub({ create: { status: 400, body: { msg: "Password should be at least 12 characters" } } });
    const r = await sh(base, 'rc=0; create_user "a@sanpo.test" "pw" || rc=$?; echo "[exit $rc]"');
    expect(r.out).toContain("[exit 1]");
    expect(r.err).toContain("HTTP 400 — Password should be at least 12 characters");
  });

  it("on a collision, says the DELETE failed when the lookup can see the leftover", async () => {
    const { base } = await stub({
      users: [{ id: "stale-id", email: "a@sanpo.test" }],
      create: { status: 422, body: { msg: "A user with this email address has already been registered" } },
    });
    const r = await sh(base, 'create_user "a@sanpo.test" "pw" || true');
    expect(r.err).toContain("Cleanup did not delete the leftover::The lookup can see a@sanpo.test as stale-id");
  });

  it("on a collision, says the SEARCH failed when the lookup cannot see it", async () => {
    const { base } = await stub({
      users: [],
      create: { status: 422, body: { msg: "A user with this email address has already been registered" } },
    });
    const r = await sh(base, 'create_user "a@sanpo.test" "pw" || true');
    expect(r.err).toContain("The lookup cannot see the leftover");
  });

  it("on a collision, does not call a failed lookup a blind one", async () => {
    const { base } = await stub({
      listStatus: 401,
      create: { status: 422, body: { msg: "A user with this email address has already been registered" } },
    });
    const r = await sh(base, 'create_user "a@sanpo.test" "pw" || true');
    expect(r.err).toContain("The leftover could not be looked up");
    expect(r.err).not.toContain("cannot see the leftover");
  });

  it("survives a body that is not JSON under bash -e", async () => {
    const { base } = await stub({ create: { status: 502, body: "<html>bad gateway</html>" } });
    const r = await sh(base, 'rc=0; create_user "a@sanpo.test" "pw" || rc=$?; echo "[exit $rc]"');
    expect(r.out).toContain("[exit 1]");
    expect(r.err).toContain("HTTP 502");
  });
});
