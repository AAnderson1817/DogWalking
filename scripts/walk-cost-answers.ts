// One answer per case, for scripts/check-walk-cost-parity.sh.
//
// The TypeScript third of the walk-cost parity check: it prints the credit
// cost `weekendWalkCost` computes for each case in scripts/walk-cost-cases.txt,
// in file order, so the shell script can line them up against what Postgres
// says twice over — the `fn_snapshot_walk_price` trigger and `fn_walk_cost`.
//
//   deno run --allow-read=. scripts/walk-cost-answers.ts <cases-file> <expected-zone>
//
// The shell script runs this three times — under two fixed offsets either
// side of the day boundary and under America/Chicago across a DST transition
// — and passes the zone in as well as in TZ, so a runtime that did not honour
// TZ is REFUSED here rather than answering in whatever zone it woke up in.
// The zone is REQUIRED, not optional: with it optional, a shell edit that
// dropped the argument kept the gate green with the refusal inert, pinning
// nothing about TZ while looking as though it had (review of PR 2, both
// passes).
//
// It imports the app's LEAF module by exact path. `walk-cost.ts` has zero
// imports for precisely this reason: deno does not resolve the extensionless
// `./types` import in `credits.ts`, so the arithmetic Booking quotes had to
// live somewhere deno can load unchanged. An import added to that leaf is what
// breaks this script — and this script is the only thing tying the three
// copies of the expression together.
//
// A separate file rather than a heredoc because `deno run -` reads the PROGRAM
// from stdin, which is where the cases would otherwise have to arrive.
import { weekendWalkCost } from "../app/src/lib/walk-cost.ts";

const cases = Deno.args[0];
const zone = Deno.args[1];
if (!cases || !zone) {
  console.error("usage: walk-cost-answers.ts <cases-file> <expected-zone> — the zone is required; a run that names none pins nothing");
  Deno.exit(2);
}
const actual = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (actual !== zone) {
  console.error(`the runtime is in ${actual}, not ${zone}: TZ was not honoured, so this run would pin nothing about the leaf's zone handling`);
  Deno.exit(2);
}
for (const line of Deno.readTextFileSync(cases).split("\n")) {
  if (/^\s*(#|$)/.test(line)) continue;
  // expected<TAB>credit_cost<TAB>surcharge<TAB>YYYY-MM-DD; the expectation is
  // the shell script's to compare, not ours to read.
  const [, cost, surcharge, date] = line.split("\t");
  if (cost === undefined || surcharge === undefined || date === undefined) {
    // Refused by line, never skipped: a case that silently drops out here
    // would be one answer short, which the shell script reports as a count
    // mismatch — but the sentence naming the line belongs where the line is.
    console.error(`unreadable case: ${JSON.stringify(line)}`);
    Deno.exit(2);
  }
  console.log(String(weekendWalkCost(Number(cost), Number(surcharge), date)));
}
