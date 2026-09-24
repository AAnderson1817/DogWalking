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

/** Runs the script over a scratch tree of fixtures; returns its exit status and the fixtures it failed. */
function verify(fixtures: Record<string, string | null>): { status: number | null; failed: string[]; out: string } {
  const root = mkdtempSync(join(tmpdir(), "workflows-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, ref] of Object.entries(fixtures)) {
    writeFileSync(join(root, ".github", "workflows", `${name}.yml`), chained(name, ref));
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
      alone: "${{ github.event.workflow_run.head_sha }}",
      tight: "${{github.event.workflow_run.head_sha||github.sha}}",
      wrapped: "${{ (github.event.workflow_run.head_sha || github.sha) }}",
      "first-wrapped": "${{ (github.event.workflow_run.head_sha) || github.sha }}",
      "both-wrapped": "${{ (github.event.workflow_run.head_sha) || (github.sha) }}",
      nested: "${{ ((github.event.workflow_run.head_sha || github.sha) || github.sha) }}",
      // A `||` or a parenthesis inside a string literal, or a doubled quote,
      // is not structure.
      "fallback-with-bars": "${{ github.event.workflow_run.head_sha || format('{0}||{1}', github.sha, 'x') }}",
      "fallback-with-paren": "${{ github.event.workflow_run.head_sha || 'a)' }}",
      "fallback-with-quote": "${{ github.event.workflow_run.head_sha || 'it''s' }}",
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
      // Refused rather than guessed, although each may select the right SHA:
      // the check reads the canonical spelling and nothing else (a stated
      // boundary — any other spelling is one edit away from it).
      "format-of-sha": "${{ format('{0}', github.event.workflow_run.head_sha) }}",
      "index-syntax": "${{ github['event']['workflow_run']['head_sha'] || github.sha }}",
      uppercase: "${{ GITHUB.EVENT.WORKFLOW_RUN.HEAD_SHA || github.sha }}",
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

  it("passes when every chained checkout selects the upstream SHA first", () => {
    const run = verify({ canonical: PIN, alone: "${{ github.event.workflow_run.head_sha }}" });
    expect(run.out).toMatch(/^PASS: .*\(2 checked\)/m);
    expect(run.status).toBe(0);
  });
});
