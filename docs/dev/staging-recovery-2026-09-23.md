# Staging recovery — 2026-09-23

The owner replaced the staging environment's `SUPABASE_ACCESS_TOKEN`. Retrying
[deploy run 35898992251](https://github.com/AAnderson1817/DogWalking/actions/runs/35898992251)
then passed both project linking and migrations for `ef662eb518344be29bab9b9cad211c88cf2380c2`.

Function deployment failed before upload: pulling
`ghcr.io/supabase/edge-runtime:v1.74.2` returned `toomanyrequests` and Docker exit
125. The workflow's three attempts and a second fresh GitHub runner reproduced
the same failure. The frontend release and function verification were skipped;
this is not a successful staging deployment.

The staging deployment now requests `supabase functions deploy --use-api`.
[Supabase documents this mode](https://supabase.com/docs/guides/functions/quickstart)
as server-side bundling without Docker. The existing retries, authentication
configuration, vault check, function probes and release gates remain in place.
The production workflow is unchanged; this change must be demonstrated on
staging before applying it there.

The Vercel `paw-trail/dog-walking` project's primary environment was also changed
from tracking `main` to `release/staging`. The dashboard confirmed "Branch tracking
saved". Its existing deployment continues serving until a successful release.

After this change merges, confirm function deployment and probes complete,
`release/staging` advances, the served `/version.json` matches, and the chained
smoke and auth-posture runs execute successfully. Check warnings for missing
secrets; a workflow's green result alone is not proof of payment or vault readiness.


## Follow-up, 2026-09-23

Staging demonstrated the new path: deploy run 105 on `4c45ab1` bundled every
function with `--use-api`, the boot probe verified each one, and
`release/staging` advanced to the commit it deployed. The `ops(cli-2.117)`
change then moved production's function deploy to `--use-api` too, and moved
the CLI in both workflows from 2.109.1 to 2.117.0. `scripts/verify-workflows.py`
rule 5 now holds the two workflows to one CLI release and one function-deploy
invocation, so they cannot drift apart this way again. That change reaches
staging first, like every merge; production still deploys only by dispatch.
