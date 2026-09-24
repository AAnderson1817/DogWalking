import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `scripts/check-function-config.py` (validate gate 10h) refuses a
 * `[functions.<name>]` setting the Supabase CLI would not apply.
 * `supabase functions deploy` ignores a key it does not know, so
 * `verfy_jwt = false` on a webhook deploys cleanly and leaves the gateway's JWT
 * check on: every Stripe delivery would get a 401. The deploy probe cannot see
 * that, because it sends the service-role key, which the gateway accepts.
 *
 * The script re-checks its own rule probes on every run. What those cannot
 * reach is how it reads the tree: the workflows that say which CLI deploys,
 * the functions this repository ships, and the config itself. Each of those
 * refuses when it reads nothing, and a reader that sees nothing reports
 * agreement, so the refusals are pinned here, over fixture trees, as CI runs
 * the script.
 */

const REPO = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO, "scripts", "check-function-config.py");

interface Tree {
  /** config.toml's text. */
  config: string;
  /** The CLI version the one fixture workflow pins, or `null` for a workflow with no setup-cli step. */
  cli?: string | null;
  /** Function directories that carry an index.ts. */
  functions?: string[];
}

/** Runs the script over a scratch tree; returns its exit status and output. */
function check({ config, cli = "2.117.0", functions = ["stripe-webhook"] }: Tree): { status: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), "function-config-"));
  const workflows = join(root, "workflows");
  const fnDir = join(root, "functions");
  mkdirSync(workflows, { recursive: true });
  mkdirSync(fnDir, { recursive: true });
  for (const name of functions) {
    mkdirSync(join(fnDir, name));
    writeFileSync(join(fnDir, name, "index.ts"), "");
  }
  const steps = cli === null ? ["      - run: echo no cli"] : ["      - uses: supabase/setup-cli@0000", "        with:", `          version: ${cli}`];
  writeFileSync(join(workflows, "deploy.yml"), ["jobs:", "  deploy:", "    runs-on: ubuntu-latest", "    steps:", ...steps, ""].join("\n"));
  writeFileSync(join(root, "config.toml"), config);
  const run = spawnSync("python3", [SCRIPT], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, FUNCTION_CONFIG: join(root, "config.toml"), FUNCTIONS_DIR: fnDir, WORKFLOWS_DIR: workflows },
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

const HEALTHY = "[functions.stripe-webhook]\nverify_jwt = false\n";

describe("check-function-config: every function setting is one the CLI applies", () => {
  it("passes the real tree (the control)", () => {
    const run = spawnSync("python3", [SCRIPT], { cwd: REPO, encoding: "utf8" });
    expect(`${run.stdout}${run.stderr}`).toMatch(/^PASS: \d+ \[functions\.<name>\] tables name shipped functions/m);
    expect(run.status).toBe(0);
  });

  it("passes a fixture tree the CLI applies as written", () => {
    const run = check({ config: HEALTHY });
    expect(run.out).toMatch(/^PASS: 1 \[functions\.<name>\] tables/m);
    expect(run.status).toBe(0);
  });

  it("refuses a key the CLI ignores, and a table for a function this repository does not ship", () => {
    const run = check({ config: "[functions.stripe-webhook]\nverfy_jwt = false\n\n[functions.stripe_webhook]\nverify_jwt = false\n" });
    expect(run.out).toContain("[functions.stripe-webhook] has the key `verfy_jwt`, which the CLI ignores without a word");
    expect(run.out).toContain("[functions.stripe_webhook] names no function this repository ships");
    expect(run.status).toBe(1);
  });

  it("refuses a config with no function table, rather than reporting agreement", () => {
    const run = check({ config: "[db]\nport = 54322\n" });
    expect(run.out).toContain("read no [functions.<name>] table");
    expect(run.status).toBe(1);
  });

  it("refuses workflows it could read no CLI in, since then it cannot tell which schema applies", () => {
    const run = check({ config: HEALTHY, cli: null });
    expect(run.out).toContain("read no supabase/setup-cli step");
    expect(run.status).toBe(1);
  });

  it("refuses a pin that moved away from the release the key list was read from", () => {
    const run = check({ config: HEALTHY, cli: "2.118.0" });
    expect(run.out).toContain("pin the Supabase CLI at 2.118.0, but the key list here was read from 2.117.0");
    expect(run.status).toBe(1);
  });

  it("refuses a repository it could find no function in, rather than checking against nothing", () => {
    const run = check({ config: HEALTHY, functions: [] });
    expect(run.out).toContain("scripts/repo-functions.sh named no function");
    expect(run.status).toBe(1);
  });
});
