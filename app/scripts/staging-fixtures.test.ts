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
  /** POST auth/v1/token (password grant) answer; default a session */
  token?: { status: number; body: unknown };
  /** POST rest/v1/rpc/fn_purge_client answer; default 200 [] */
  purge?: { status: number; body: unknown };
  /** drop the fn_purge_client connection without answering */
  purgeDrop?: boolean;
}

/** What a request carried: the credentials and the body a test may pin. */
interface Seen {
  line: string;
  apikey?: string;
  authorization?: string;
  body: string;
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function stub(s: Stub): Promise<{ base: string; requests: string[]; seen: Seen[] }> {
  const requests: string[] = [];
  const seen: Seen[] = [];
  const users = s.users ?? [];
  const cap = s.cap ?? 100;
  server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const header = (h: string | string[] | undefined) => (Array.isArray(h) ? h.join(",") : h);
    // Routed once the body has arrived, so a test can pin what a POST sent.
    const route = (method: string, url: URL, body: string) => {
      const line = `${method} ${url.pathname}${url.search}`;
      requests.push(line);
      seen.push({ line, apikey: header(req.headers.apikey), authorization: header(req.headers.authorization), body });
      if (method === "GET" && url.pathname === "/auth/v1/admin/users") {
        if (s.listStatus) return json(s.listStatus, { msg: "Invalid API key" });
        if (s.listBodyless) return json(200, { msg: "ok" });
        const per = Math.min(Number(url.searchParams.get("per_page") ?? 50), cap);
        const page = s.ignorePage ? 1 : Number(url.searchParams.get("page") ?? 1);
        return json(200, { users: users.slice((page - 1) * per, page * per) });
      }
      if (method === "POST" && url.pathname === "/auth/v1/admin/users") {
        const c = s.create ?? { status: 200, body: { id: "new-user-id" } };
        // A string is sent as it is — a gateway's HTML error page is not JSON.
        if (typeof c.body === "string") {
          res.writeHead(c.status, { "content-type": "text/html" });
          res.end(c.body);
          return;
        }
        return json(c.status, c.body);
      }
      if (method === "POST" && url.pathname === "/auth/v1/token") {
        const tk = s.token ?? { status: 200, body: { access_token: "op-session-token" } };
        return json(tk.status, tk.body);
      }
      if (method === "POST" && url.pathname === "/rest/v1/rpc/fn_purge_client") {
        if (s.purgeDrop) return void req.socket.destroy();
        const pg = s.purge ?? { status: 200, body: [] };
        return json(pg.status, pg.body);
      }
      if (method === "DELETE") {
        const status = Object.entries(s.deletes ?? {}).find(([p]) => url.pathname.startsWith(p))?.[1] ?? 204;
        res.writeHead(status).end();
        return;
      }
      res.writeHead(404).end();
    };
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => route(req.method ?? "", new URL(req.url ?? "/", "http://localhost"), body));
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  const port = (server!.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, requests, seen };
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
          ANON_KEY: "stub-anon-key",
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
    // The bound is low so that a broken guard fails on its sentence, fast.
    const r = await sh(base, 'rc=0; USER_LOOKUP_MAX_PAGES=5 user_id_for "nobody@sanpo.test" || rc=$?; echo "[exit $rc]"');
    expect(r.out).toBe("[exit 9]\n");
    expect(r.err).toContain("page 2 repeated page 1");
    expect(requests.filter((q) => q.startsWith("GET")).length).toBe(2);
  });

  it("exits 9 when it runs out of pages before reaching the end", async () => {
    // The bound stops a huge user table spinning here forever. Reaching it
    // means the search did not finish, which is not the same as absent. Three
    // pages rather than the default fifty: fifty sequential curl and jq
    // rounds timed out a slower machine at vitest's 5 s (Codex, on #97).
    const { base, requests } = await stub({ users: many(350) });
    const r = await sh(base, 'rc=0; USER_LOOKUP_MAX_PAGES=3 user_id_for "nobody@sanpo.test" || rc=$?; echo "[exit $rc]"');
    expect(r.out).toBe("[exit 9]\n");
    expect(r.err).toContain("read 3 pages");
    expect(requests.filter((q) => q.startsWith("GET")).length).toBe(3);
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
    // Not "Rows accumulate in staging until this is fixed", which every run
    // printed four times for a fixture no delete could remove.
    expect(r.out).toContain(
      "::warning title=Fixture cleanup left something behind::DELETE operator op-1 -> HTTP 409, so it stays in staging. On a healthy run nothing does.",
    );
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

describe("sign_in and purge_client", () => {
  it("sign in with the anon key, as the app does, and print only the token", async () => {
    const { base, seen } = await stub({});
    const r = await sh(base, 'tok=$(sign_in "op@sanpo.test" "pw"); echo "[$tok]"');
    expect(r.out).toBe("[op-session-token]\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ line: "POST /auth/v1/token?grant_type=password", apikey: "stub-anon-key" });
    expect(seen[0]!.authorization).toBeUndefined();
    expect(JSON.parse(seen[0]!.body)).toEqual({ email: "op@sanpo.test", password: "pw" });
  });

  it("name GoTrue's own refusal when the sign-in fails", async () => {
    const { base } = await stub({ token: { status: 400, body: { error_description: "Invalid login credentials" } } });
    const r = await sh(base, 'rc=0; tok=$(sign_in "op@sanpo.test" "pw") || rc=$?; echo "[$tok][exit $rc]"');
    expect(r.out).toBe("[][exit 1]\n");
    expect(r.err).toContain("sign-in as op@sanpo.test refused: HTTP 400 — Invalid login credentials");
  });

  it("do not take a 2xx that carries no token as a session", async () => {
    const { base } = await stub({ token: { status: 200, body: { msg: "ok" } } });
    const r = await sh(base, 'rc=0; tok=$(sign_in "op@sanpo.test" "pw") || rc=$?; echo "[$tok][exit $rc]"');
    expect(r.out).toBe("[][exit 1]\n");
    expect(r.err).toContain("HTTP 200");
  });

  it("purge with the caller's session, not the service key", async () => {
    // fn_purge_client answers only the client's own operator, so the service
    // key would be refused as "no such client": the session is the point.
    const { base, seen } = await stub({});
    const r = await sh(base, 'f=$(mktemp); code=$(purge_client "op-session-token" "cl-1" "$f"); echo "[$code]"; cat "$f"');
    expect(r.out).toBe("[200]\n[]");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      line: "POST /rest/v1/rpc/fn_purge_client",
      apikey: "stub-anon-key",
      authorization: "Bearer op-session-token",
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({ p_client: "cl-1" });
  });
});

describe("erase_client", () => {
  it("purges as the operator, then deletes the client, and says nothing else", async () => {
    const { base, requests, seen } = await stub({});
    const r = await sh(base, 'erase_client "op@sanpo.test" "pw" "cl-1"');
    expect(r.code).toBe(0);
    expect(requests).toEqual([
      "POST /auth/v1/token?grant_type=password",
      "POST /rest/v1/rpc/fn_purge_client",
      "DELETE /rest/v1/clients?id=eq.cl-1",
    ]);
    expect(seen[1]!.authorization).toBe("Bearer op-session-token");
    // The row goes with the service key, like every other fixture row: the
    // delete is housekeeping, and only the purge has to be the operator's.
    expect(seen[2]!.authorization).toBe("Bearer stub-service-key");
    // The operator's session is masked before anything could print it.
    expect(r.out).toBe("::add-mask::op-session-token\n");
  });

  it("reports a refused sign-in, and still tries the delete", async () => {
    // A client that never claimed has no attempt rows, and deletes without a
    // purge: the warning is for the purge, not a reason to stop.
    const { base, requests } = await stub({ token: { status: 400, body: { error_description: "Invalid login credentials" } } });
    const r = await sh(base, 'erase_client "op@sanpo.test" "pw" "cl-1"; echo "[after]"');
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "::warning title=Fixture cleanup left something behind::could not sign in as op@sanpo.test to purge client cl-1",
    );
    expect(r.err).toContain("HTTP 400 — Invalid login credentials");
    expect(requests).toEqual(["POST /auth/v1/token?grant_type=password", "DELETE /rest/v1/clients?id=eq.cl-1"]);
    expect(r.out).toContain("[after]");
  });

  it("reports a refused purge with the database's own message, and still tries the delete", async () => {
    const { base, requests } = await stub({
      purge: { status: 400, body: { code: "P0001", message: "fn_purge_client: no such client" } },
      deletes: { "/rest/v1/clients": 409 },
    });
    const r = await sh(base, 'erase_client "op@sanpo.test" "pw" "cl-1"; echo "[after]"');
    expect(r.code).toBe(0);
    expect(r.out).toContain("fn_purge_client for client cl-1 -> HTTP 400 — fn_purge_client: no such client.");
    expect(r.out).toContain("DELETE client cl-1 -> HTTP 409, so it stays in staging.");
    expect(requests.at(-1)).toBe("DELETE /rest/v1/clients?id=eq.cl-1");
    expect(r.out).toContain("[after]");
  });

  it("reports an unreachable API instead of aborting the teardown", async () => {
    // The teardown runs from an EXIT trap under `bash -e`: a curl that cannot
    // connect must not end it before the operator and accounts are reached.
    const r = await sh(
      "http://127.0.0.1:1",
      'shopt -s inherit_errexit; erase_client "op@sanpo.test" "pw" "cl-1"; echo "[after]"',
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("could not sign in as op@sanpo.test to purge client cl-1");
    expect(r.out).toContain("DELETE client cl-1 -> HTTP 000");
    expect(r.out).toContain("[after]");
  });

  it("reports a purge whose connection dropped, and still tries the delete", async () => {
    // Signed in, then nothing: curl exits non-zero with no answer. Under
    // `bash -e` that would end the teardown here, before the operator and
    // the accounts, unless purge_client still prints a status (000).
    const { base, requests } = await stub({ purgeDrop: true });
    const r = await sh(base, 'shopt -s inherit_errexit; erase_client "op@sanpo.test" "pw" "cl-1"; echo "[after]"');
    expect(r.code).toBe(0);
    expect(r.out).toContain("fn_purge_client for client cl-1 -> HTTP 000 — no answer.");
    expect(requests.at(-1)).toBe("DELETE /rest/v1/clients?id=eq.cl-1");
    expect(r.out).toContain("[after]");
  });

  it("does nothing at all for an empty client id", async () => {
    const { base, requests } = await stub({});
    const r = await sh(base, 'erase_client "op@sanpo.test" "pw" ""');
    expect(r).toMatchObject({ code: 0, out: "" });
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

  it("does not take an id from a response that failed (Codex, on #97)", async () => {
    // A collision that names the EXISTING user: the replay would have adopted
    // it as its fixture and its EXIT trap would have deleted it.
    const { base } = await stub({
      users: [{ id: "someone-else", email: "a@sanpo.test" }],
      create: {
        status: 422,
        body: { id: "someone-else", msg: "A user with this email address has already been registered" },
      },
    });
    const r = await sh(base, 'rc=0; uid=$(create_user "a@sanpo.test" "pw") || rc=$?; echo "[$uid][exit $rc]"');
    expect(r.out).toBe("[][exit 1]\n");
    expect(r.err).toContain("HTTP 422 — A user with this email address has already been registered");
    expect(r.err).toContain("names user someone-else, which is not taken as this run's fixture");
    // The collision diagnosis still runs: it is what a 422 exists to trigger.
    expect(r.err).toContain("Cleanup did not delete the leftover");
  });

  it("does not take an id from a gateway error either", async () => {
    const { base } = await stub({ create: { status: 502, body: { id: "cached-id", message: "upstream timed out" } } });
    const r = await sh(base, 'rc=0; uid=$(create_user "a@sanpo.test" "pw") || rc=$?; echo "[$uid][exit $rc]"');
    expect(r.out).toBe("[][exit 1]\n");
    expect(r.err).toContain("HTTP 502 — upstream timed out");
  });

  it("takes the id from any 2xx, not only a 200", async () => {
    const { base } = await stub({ create: { status: 201, body: { id: "created" } } });
    const r = await sh(base, 'uid=$(create_user "a@sanpo.test" "pw"); echo "[$uid]"');
    expect(r.out).toBe("[created]\n");
  });

  it("does not report success for a 2xx that names no user", async () => {
    const { base } = await stub({ create: { status: 200, body: { msg: "ok" } } });
    const r = await sh(base, 'rc=0; uid=$(create_user "a@sanpo.test" "pw") || rc=$?; echo "[$uid][exit $rc]"');
    expect(r.out).toBe("[][exit 1]\n");
    expect(r.err).toContain("HTTP 200");
  });

  it("survives a body that is not JSON under bash -e", async () => {
    const { base } = await stub({ create: { status: 502, body: "<html>bad gateway</html>" } });
    const r = await sh(base, 'rc=0; create_user "a@sanpo.test" "pw" || rc=$?; echo "[exit $rc]"');
    expect(r.out).toContain("[exit 1]");
    expect(r.err).toContain("HTTP 502 — an unreadable body");
  });

  it("says there was no answer, rather than printing a blank, when the connection fails", async () => {
    const r = await sh("http://127.0.0.1:1", 'rc=0; create_user "a@sanpo.test" "pw" || rc=$?; echo "[exit $rc]"');
    expect(r.out).toContain("[exit 1]");
    expect(r.err).toContain("HTTP 000 — no answer");
  });
});
