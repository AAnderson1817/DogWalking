import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `scripts/verify-workflows.py` (validate gate 10c) holds the deploy
 * workflows to rules their YAML cannot express, and until now its only proofs
 * were sabotages run by hand against the real files. This drives the script
 * itself, as CI runs it, against fixture workflows in a scratch tree: it
 * reads `.github/workflows` from its working directory.
 *
 * Rule 4 is the one pinned here. A workflow triggered by `workflow_run` must
 * check out the commit the upstream run tested or deployed, and `github.sha`
 * on that event is main's newest commit when the run starts. The rule used to
 * accept any `ref` CONTAINING `github.event.workflow_run.head_sha`, so
 * `${{ github.sha || github.event.workflow_run.head_sha }}` passed while
 * `github.sha`, always set, was the value selected (Codex, on #97). It reads
 * the expression now: `||` yields its first truthy operand, and head_sha is
 * always set on the event that matters, so it must be the first choice.
 *
 * The rest of the chain is the fallback, and a manual dispatch is when it is
 * chosen: head_sha is empty on that event. So the fallback is read too, and
 * must be `github.sha`, the commit dispatched — the rule accepted
 * `head_sha || inputs.ref`, which checks out whatever ref the dispatcher typed
 * (Codex, on #97, one round later).
 *
 * Rule 5 is pinned here too. Staging is the only place a Supabase CLI release
 * or a function-deploy path runs before production does, so every
 * `supabase/setup-cli` step must pin one commit and one exact release, and
 * every `supabase functions deploy` must run with the same flags. It compares
 * workflows with one another, and the real tree agrees, so only fixtures can
 * show it a disagreement: the owner's 4c45ab1 moved staging's deploy to
 * `--use-api` and left production on the Docker bundler, which is the drift
 * the fixtures below reproduce.
 */

const REPO = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO, "scripts", "verify-workflows.py");

/** A workflow_run-triggered workflow whose one job checks out at `ref`, or with no ref at all. */
function chained(job: string, ref: string | null): string {
  const lines = [
    "on:",
    "  workflow_run:",
    "    workflows: [CI]",
    "    types: [completed]",
    "jobs:",
    `  ${job}:`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
  ];
  // A JSON string is a valid YAML double-quoted scalar, so the ref arrives verbatim.
  if (ref !== null) lines.push("        with:", `          ref: ${JSON.stringify(ref)}`);
  return `${lines.join("\n")}\n`;
}

const SETUP_CLI = "46f7f98c7f948ad727d22c1e67fab04c223a0520";

interface Deploying {
  commit?: string;
  /** `null` leaves the `with: version:` out. */
  version?: string | null;
  flags?: string;
  /** `false` leaves the setup-cli step out. */
  cli?: boolean;
  /** `false` replaces the function deploy with a step that deploys nothing. */
  deploy?: boolean;
}

/**
 * A push-triggered workflow whose one job installs the Supabase CLI and
 * deploys every function: the evidence rule 5 reads.
 */
function deploying(job: string, opts: Deploying = {}): string {
  const { commit = SETUP_CLI, version = "2.117.0", flags = "--use-api", cli = true, deploy = true } = opts;
  const lines = ["on:", "  push:", "    branches: [main]", "jobs:", `  ${job}:`, "    runs-on: ubuntu-latest", "    steps:"];
  if (cli) {
    lines.push(`      - uses: supabase/setup-cli@${commit}`);
    if (version !== null) lines.push("        with:", `          version: ${version}`);
  }
  const run = deploy ? `supabase functions deploy ${flags} --project-ref x`.replace(/ {2,}/g, " ") : "echo nothing to deploy";
  lines.push(`      - run: ${run}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Runs the script over a scratch tree of fixtures; returns its exit status and
 * the fixtures it failed. `raw` adds whole workflow files. By default it adds
 * one that installs the CLI and deploys functions, since without one rule 5
 * refuses the tree for having shown it nothing.
 */
function verify(
  fixtures: Record<string, string | null>,
  raw: Record<string, string> = { deploy: deploying("deploy") },
): { status: number | null; failed: string[]; out: string } {
  const root = mkdtempSync(join(tmpdir(), "workflows-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, ref] of Object.entries(fixtures)) {
    writeFileSync(join(root, ".github", "workflows", `${name}.yml`), chained(name, ref));
  }
  for (const [name, text] of Object.entries(raw)) {
    writeFileSync(join(root, ".github", "workflows", `${name}.yml`), text);
  }
  const run = spawnSync("python3", [SCRIPT], { cwd: root, encoding: "utf8" });
  const out = `${run.stdout}${run.stderr}`;
  const failed = [...out.matchAll(/^::error::(\S+)\.yml :: /gm)].map((m) => m[1]).sort();
  return { status: run.status, failed, out };
}

const PIN = "${{ github.event.workflow_run.head_sha || github.sha }}";

describe("verify-workflows rule 4: a chained run checks out the commit it follows", () => {
  it("passes the real workflows (the control)", () => {
    const run = spawnSync("python3", [SCRIPT], { cwd: REPO, encoding: "utf8" });
    expect(`${run.stdout}${run.stderr}`).toMatch(/^PASS: /m);
    expect(run.status).toBe(0);
  });

  it("reads which value the ref selects, not whether it mentions the upstream SHA (Codex, on #97)", () => {
    const healthy: Record<string, string | null> = {
      canonical: PIN,
      tight: "${{github.event.workflow_run.head_sha||github.sha}}",
      wrapped: "${{ (github.event.workflow_run.head_sha || github.sha) }}",
      "first-wrapped": "${{ (github.event.workflow_run.head_sha) || github.sha }}",
      "both-wrapped": "${{ (github.event.workflow_run.head_sha) || (github.sha) }}",
      nested: "${{ ((github.event.workflow_run.head_sha || github.sha) || github.sha) }}",
      "nested-right": "${{ github.event.workflow_run.head_sha || (github.sha || github.sha) }}",
      "repeated-fallback": "${{ github.event.workflow_run.head_sha || github.sha || github.sha }}",
    };
    const unhealthy: Record<string, string | null> = {
      // Codex's case: github.sha is always set, so it is always the one chosen.
      reversed: "${{ github.sha || github.event.workflow_run.head_sha }}",
      "input-first": "${{ inputs.sha || github.event.workflow_run.head_sha }}",
      "wrapped-reversed": "${{ (github.sha || github.event.workflow_run.head_sha) }}",
      // `&&` binds tighter: the first choice is the whole conjunction, which
      // yields github.sha whenever head_sha is set.
      "and-first": "${{ github.event.workflow_run.head_sha && github.sha || github.sha }}",
      // The text inside a string is data: it names the SHA and selects nothing.
      "mention-in-string": "${{ 'github.event.workflow_run.head_sha' }}",
      "plain-sha": "${{ github.sha }}",
      "no-ref": null,
      // The ref is the whole value, so text around the expression changes it.
      suffix: "${{ github.event.workflow_run.head_sha }}-x",
      prefix: "refs/${{ github.event.workflow_run.head_sha }}",
      "two-expressions": "${{ github.event.workflow_run.head_sha || github.sha }}${{ github.sha }}",
      unbalanced: "${{ (github.event.workflow_run.head_sha || github.sha }}",
      "unterminated-string": "${{ github.event.workflow_run.head_sha || 'x }}",
      "empty-fallback": "${{ github.event.workflow_run.head_sha || }}",
      // Refused rather than guessed, although each may select the right SHA:
      // the check reads the canonical spelling and nothing else (a stated
      // boundary — any other spelling is one edit away from it).
      "format-of-sha": "${{ format('{0}', github.event.workflow_run.head_sha) }}",
      "index-syntax": "${{ github['event']['workflow_run']['head_sha'] || github.sha }}",
      uppercase: "${{ GITHUB.EVENT.WORKFLOW_RUN.HEAD_SHA || github.sha }}",
      // The fallback is what a manual dispatch checks out, since head_sha is
      // empty there (Codex, on #97): anything but github.sha is refused.
      "input-fallback": "${{ github.event.workflow_run.head_sha || inputs.ref }}",
      "format-fallback": "${{ github.event.workflow_run.head_sha || format('{0}||{1}', github.sha, 'x') }}",
      "string-fallback": "${{ github.event.workflow_run.head_sha || 'a)' }}",
      "later-fallback": "${{ github.event.workflow_run.head_sha || github.sha || inputs.ref }}",
      "nested-fallback": "${{ (github.event.workflow_run.head_sha || inputs.ref) || github.sha }}",
      // No fallback: a manual dispatch checks out an empty ref, which is
      // actions/checkout's default rather than anything this ref says.
      alone: "${{ github.event.workflow_run.head_sha }}",
    };
    const run = verify({ ...healthy, ...unhealthy });
    expect(run.failed, run.out).toEqual(Object.keys(unhealthy).sort());
    expect(run.status).toBe(1);
  });

  it("says why a ref is refused, and what to write instead", () => {
    const run = verify({ reversed: "${{ github.sha || github.event.workflow_run.head_sha }}" });
    expect(run.out).toContain("whose first choice is `github.sha`");
    expect(run.out).toContain(`ref: ${PIN}`);
  });

  it("says a manual dispatch checks out the fallback, and names it (Codex, on #97)", () => {
    const run = verify({ "input-fallback": "${{ github.event.workflow_run.head_sha || inputs.ref }}" });
    expect(run.out).toContain("whose fallback is `inputs.ref`, not `github.sha`");
    expect(run.out).toContain("a manual dispatch");
    expect(run.out).toContain(`ref: ${PIN}`);
    expect(run.out).not.toContain("main's newest commit");
  });

  it("says a ref with no fallback has none", () => {
    const run = verify({ alone: "${{ github.event.workflow_run.head_sha }}" });
    expect(run.out).toContain("which has no fallback");
  });

  it("reads a `||`, a parenthesis or a quote inside a string as data, not structure", () => {
    // Each fallback is refused (it is not github.sha); what the message names
    // as the fallback shows how far the string reached. Were the `||` in the
    // first one structure, the fallback named would be `format('{0}`; were the
    // parenthesis in the second, the chain would not close at all.
    const run = verify({
      bars: "${{ github.event.workflow_run.head_sha || format('{0}||{1}', github.sha, 'x') }}",
      paren: "${{ github.event.workflow_run.head_sha || 'a)' }}",
      quote: "${{ github.event.workflow_run.head_sha || 'it''s' }}",
    });
    expect(run.out).toContain("whose fallback is `format('{0}||{1}', github.sha, 'x')`");
    expect(run.out).toContain("whose fallback is `'a)'`");
    expect(run.out).toContain("whose fallback is `'it''s'`");
  });

  it("says when it cannot read the chain, and why", () => {
    const run = verify({
      "unterminated-string": "${{ github.event.workflow_run.head_sha || 'x }}",
      "empty-fallback": "${{ github.event.workflow_run.head_sha || }}",
    });
    expect(run.failed).toEqual(["empty-fallback", "unterminated-string"]);
    expect(run.out.match(/which the check cannot read as a `\|\|` chain/g)?.length).toBe(2);
  });

  it("passes when every chained checkout selects the upstream SHA first and github.sha after it", () => {
    const run = verify({ canonical: PIN, nested: "${{ ((github.event.workflow_run.head_sha || github.sha) || github.sha) }}" });
    expect(run.out).toMatch(/^PASS: .*\(2 checked\)/m);
    expect(run.status).toBe(0);
  });
});

describe("verify-workflows rule 5: production runs the CLI and the deploy path staging ran", () => {
  // One healthy chained checkout, so rule 4 has something to inspect and the
  // only thing that can fail here is rule 5.
  const CHAINED = { smoke: PIN };
  const two = (staging: Deploying, production: Deploying) => ({
    "deploy-staging": deploying("functions", staging),
    "deploy-production": deploying("functions", production),
  });

  it("passes one setup-cli commit, one exact release and one set of deploy flags", () => {
    const run = verify(CHAINED, two({}, {}));
    expect(run.out).toMatch(/^PASS: .*one Supabase CLI \(2\.117\.0, 2 pins\) and one function-deploy path \(2 deploys\)/m);
    expect(run.status).toBe(0);
  });

  it("refuses production deploying by a path staging does not run (the drift 4c45ab1 left)", () => {
    const run = verify(CHAINED, two({ flags: "--use-api" }, { flags: "" }));
    expect(run.out).toContain("`supabase functions deploy` runs with different flags");
    expect(run.out).toContain("deploy-production.yml :: functions = --project-ref");
    expect(run.out).toContain("deploy-staging.yml :: functions = --project-ref --use-api");
    expect(run.status).toBe(1);
  });

  it("refuses two CLI releases, naming each job's", () => {
    const run = verify(CHAINED, two({ version: "2.117.0" }, { version: "2.109.1" }));
    expect(run.out).toContain("the Supabase CLI version differs between jobs");
    expect(run.out).toContain("deploy-production.yml :: functions = 2.109.1");
    expect(run.out).toContain("deploy-staging.yml :: functions = 2.117.0");
    expect(run.status).toBe(1);
  });

  it("refuses two setup-cli commits", () => {
    const run = verify(CHAINED, two({}, { commit: "0".repeat(40) }));
    expect(run.out).toContain("the supabase/setup-cli commit differs between jobs");
    expect(run.status).toBe(1);
  });

  it("refuses a setup-cli tag, and a CLI version that is not one exact release", () => {
    const run = verify(
      {},
      {
        tag: deploying("functions", { commit: "v3" }),
        latest: deploying("functions", { version: "latest" }),
        range: deploying("functions", { version: "2.x" }),
        unset: deploying("functions", { version: null }),
      },
    );
    expect(run.failed).toEqual(["latest", "range", "tag", "unset"]);
    expect(run.out).toContain("supabase/setup-cli is pinned to `v3`, not a commit SHA");
    expect(run.out).toContain("the Supabase CLI version is `latest`, not an exact release");
    expect(run.out).toContain("the Supabase CLI version is `(unset)`, not an exact release");
  });

  it("refuses a tree it could read no CLI or no function deploy in, rather than reporting agreement", () => {
    const noCli = verify(CHAINED, { deploy: deploying("functions", { cli: false }) });
    expect(noCli.out).toContain("rule 5 inspected no supabase/setup-cli step in any workflow — it checked nothing");
    expect(noCli.status).toBe(1);
    const noDeploy = verify(CHAINED, { deploy: deploying("functions", { deploy: false }) });
    expect(noDeploy.out).toContain("rule 5 inspected no `supabase functions deploy` in any workflow — it checked nothing");
    expect(noDeploy.status).toBe(1);
  });
});
