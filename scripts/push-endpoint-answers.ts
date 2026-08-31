// One answer per case, for scripts/check-push-endpoint-parity.sh.
//
// The TypeScript half of the push-service allowlist parity check: it prints
// `t` or `f` for each case in scripts/push-endpoint-cases.txt, in file order,
// so the shell script can line them up against what Postgres says.
//
//   deno run --allow-read=. scripts/push-endpoint-answers.ts <cases-file>
//
// A separate file rather than a heredoc because `deno run -` reads the PROGRAM
// from stdin, which is where the cases would otherwise have to arrive.
import { isPushServiceEndpoint } from "../supabase/functions/_lib/webpush.ts";

const cases = Deno.args[0];
if (!cases) {
  console.error("usage: push-endpoint-answers.ts <cases-file>");
  Deno.exit(2);
}
for (const line of Deno.readTextFileSync(cases).split("\n")) {
  if (/^\s*(#|$)/.test(line)) continue;
  console.log(isPushServiceEndpoint(line.slice(line.indexOf("\t") + 1)) ? "t" : "f");
}
