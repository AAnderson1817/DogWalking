import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `scripts/check-gate-lockstep.py` (validate gate 10g) holds `ci.yml`,
 * `SKILL.md` and `validate.sh` to one list. Its rules were proven by hand
 * until now; this drives the script itself over a scratch copy of the three
 * real files, with `ci.yml` changed in one place per case. The script finds
 * the files from its own path, so it is copied into the scratch tree beside
 * them.
 *
 * Pinned here: two `ci.yml` steps may share a name only if they are the same
 * step in the same setting (Codex, on #97). A step identical as written runs
 * differently under another job's `env`, `defaults`, `container` or runner,
 * or after other steps, and one SKILL.md row would then describe two checks.
 * The real tree has one such pair: the two `Install`s, in `frontend` and
 * `e2e-today`.
 */

const REPO = resolve(__dirname, "..", "..");
const CI = ".github/workflows/ci.yml";
const FILES = [CI, ".claude/skills/validate/SKILL.md", "scripts/validate.sh", "scripts/check-gate-lockstep.py"];

function lockstep(edit: (ci: string) => string): { status: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), "lockstep-"));
  for (const f of FILES) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    copyFileSync(join(REPO, f), join(root, f));
  }
  const ci = join(root, CI);
  writeFileSync(ci, edit(readFileSync(ci, "utf8")));
  const run = spawnSync("python3", [join(root, "scripts", "check-gate-lockstep.py")], { encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

/** Replaces text inside the e2e-today job — and insists it is there exactly once, so a case cannot pass by editing nothing. */
const inE2e = (old: string, next: string) => (ci: string) => {
  const at = ci.indexOf("\n  e2e-today:\n");
  expect(at, "ci.yml has no e2e-today job").toBeGreaterThan(0);
  // The job ends where the next one at the same indentation begins.
  const rest = ci.slice(at + 1).search(/\n {2}[\w-]+:\n/);
  const end = rest < 0 ? ci.length : at + 1 + rest;
  const job = ci.slice(at, end);
  expect(job.split(old).length - 1, `\`${old.trim()}\` in e2e-today`).toBe(1);
  return ci.slice(0, at) + job.replace(old, next) + ci.slice(end);
};

const JOB_HEAD = "    timeout-minutes: 12\n";

describe("check-gate-lockstep: a shared step name means the same step in the same setting", () => {
  it("passes the real files (the control)", () => {
    const run = lockstep((ci) => ci);
    expect(run.out).toMatch(/^GATE LOCKSTEP PASS: /m);
    expect(run.status).toBe(0);
  });

  it.each([
    ["job `env`", JOB_HEAD + "    env:\n      NODE_OPTIONS: --max-old-space-size=4096\n"],
    ["job `container`", JOB_HEAD + "    container: node:22\n"],
    ["job `defaults`", JOB_HEAD + "    defaults:\n      run:\n        working-directory: app\n"],
    ["job `services`", JOB_HEAD + "    services:\n      cache:\n        image: redis:7\n"],
    ["job `strategy`", JOB_HEAD + "    strategy:\n      matrix:\n        shard: [1, 2]\n"],
    // A key this script does not know is compared: the loud direction.
    ["job `x-unknown`", JOB_HEAD + "    x-unknown: 1\n"],
  ])("refuses the Install pair when e2e-today's %s differs (Codex, on #97)", (what, head) => {
    const run = lockstep(inE2e(JOB_HEAD, head));
    expect(run.out).toContain("`Install`");
    expect(run.out).toContain(`${what} differs`);
    expect(run.out).toContain("name them apart");
    expect(run.status).toBe(1);
  });

  it("refuses the Install pair when the runner differs", () => {
    const run = lockstep(inE2e("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-24.04\n"));
    expect(run.out).toContain("job `runs-on` differs");
    expect(run.status).toBe(1);
  });

  it("refuses the Install pair when a different step runs before one of them", () => {
    const run = lockstep(inE2e("          node-version: 22\n", "          node-version: 20\n"));
    expect(run.out).toContain("run after different steps");
    expect(run.status).toBe(1);
  });

  it("refuses the Install pair when the step itself differs", () => {
    const run = lockstep(inE2e("        run: npm ci --prefix app\n", "        run: npm ci --prefix app --ignore-scripts\n"));
    expect(run.out).toContain("share a name and differ");
    expect(run.status).toBe(1);
  });

  it("admits a difference in whether, when or for how long the job runs", () => {
    const run = lockstep(inE2e(JOB_HEAD,
      "    timeout-minutes: 20\n    needs: frontend\n    if: github.event_name == 'push'\n    continue-on-error: true\n"));
    expect(run.out).toMatch(/^GATE LOCKSTEP PASS: /m);
    expect(run.status).toBe(0);
  });
});
