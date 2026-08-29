# What `supabase db push` needs from the project it pushes to

Review M5. This repository has never applied its migrations to a real Supabase
project — `deploy-production.yml` has zero runs, and staging's history predates
most of the schema. Until now the only evidence that a deploy would work was
that `scripts/db-reset.sh` went green, and that evidence was weaker than it
looked: the reset connects as the local cluster's **bootstrap superuser**, and
a superuser skips every ownership and privilege check there is. Hosted
Supabase's `postgres` role is not a superuser.

So green CI could not distinguish "these migrations are permitted" from
"nothing checked". `scripts/db-push-check.sh` now closes half of that, and this
page is the other half.

## The two halves, kept apart

**Proved here.** `scripts/db-push-check.sh` applies all migrations from zero,
as a non-superuser role holding *only* the privileges enumerated in
`scripts/local-stack/platform-roles.sql`. That list was derived by taking
privileges away until the migrations stopped applying, so it is minimal by
construction and it runs on every CI push. If a future migration needs more,
CI fails and the new requirement has to be written down here in the same
commit.

**Not proved here, and not provable here.** Whether a given Supabase project
*grants* that much. Hosted role membership cannot be read from this
repository, and no amount of local modelling substitutes for asking the
project. That is the checklist below, and it is a one-time task before the
first production `db push`.

## Why the deploy does not run this for you

The obvious improvement is to make `deploy-production.yml` run the query itself
and refuse when a column comes back `f` — the shape this repository prefers,
and the same fail-closed treatment the vault-key verification already gets.

It is deliberately **not** done, for one specific reason that someone should
resolve before trying:

The migrate job holds `SUPABASE_DB_PASSWORD` and runs `supabase link`, so it
has the credentials. What it does not obviously have is a route. A direct
connection is `db.{ref}.supabase.co:5432`, and Supabase has been moving direct
connections to **IPv6-only**, with IPv4 served by the pooler on a different
host whose region this repository does not hold as a secret. GitHub-hosted
runners are IPv4-only. So the step might fail for a networking reason on a
correctly-configured project — and a gate that blocks the first production
deploy of this system with a connection error, on a path nobody has ever
exercised, is worse than a checklist item.

None of that is checkable from inside this repository, which is the same reason
`config push` was declined in review H2. To close it: confirm from the project's
dashboard which host and port the deploy can actually reach, then add the step
with the staging-advisory / production-fatal split used elsewhere so it proves
itself on staging before it ever gates production.

## The requirements

Run this in the project's SQL editor **as the `postgres` role** — the role
`supabase db push` connects as. Every line must come back `t`.

```sql
select
  not rolsuper                                             as not_a_superuser,
  rolbypassrls                                             as bypasses_rls,
  pg_has_role(current_user, 'anon', 'USAGE')               as member_anon,
  pg_has_role(current_user, 'authenticated', 'USAGE')      as member_authenticated,
  pg_has_role(current_user, 'service_role', 'USAGE')       as member_service_role,
  pg_has_role(current_user,
    (select relowner::regrole::text
       from pg_class where oid = 'storage.objects'::regclass), 'USAGE')
                                                           as owns_storage_objects,
  pg_has_role(current_user,
    (select relowner::regrole::text
       from pg_class where oid = 'realtime.messages'::regclass), 'USAGE')
                                                           as owns_realtime_messages,
  pg_catalog.has_schema_privilege('public', 'CREATE')       as can_create_in_public,
  has_table_privilege('auth.users', 'REFERENCES')          as references_auth_users,
  has_schema_privilege('cron', 'USAGE')                    as usage_on_cron,
  has_table_privilege('cron.job', 'INSERT')                as can_write_cron_job,
  exists (select 1 from pg_extension where extname = 'pgcrypto')
                                                           as pgcrypto_installed
from pg_roles where rolname = current_user;
```

### Why each one

| Requirement | What breaks without it |
| --- | --- |
| not a superuser | Nothing — but if it *is* one, this checklist proves nothing, because a superuser satisfies every row above for free. |
| **BYPASSRLS** | Everything. See below. |
| membership in the API roles | `grant ... to authenticated` in 0004 and after. |
| membership in the owner of `storage.objects` | `create policy` on it in 0004, 0008, 0012, 0031, 0033. Fails as `must be owner of table objects` — the failure the runbook has described for a year without anyone being able to confirm it. |
| membership in the owner of `realtime.messages` | `create policy` on it in 0020. Same error, and never mentioned anywhere before. |
| CREATE on `public` | Every table. |
| REFERENCES on `auth.users` | The `auth_user_id` foreign keys in 0002. |
| USAGE on `cron` + INSERT on `cron.job` | 0028's `cron.schedule()`, which inserts as the **calling** role — it is not a definer function. |
| `pgcrypto` installed | 0001 opens with `create extension if not exists pgcrypto`. `IF NOT EXISTS` returns before the privilege check when the extension is already there, so this only works because the platform installed it first. |

## BYPASSRLS is the one that matters

0004 puts `force row level security` on every tenant table — 23 of them.
`FORCE` means **the table's own owner is subject to its policies**, and a
`SECURITY DEFINER` function executes as its owner. So without `BYPASSRLS` on
the deploying role, all 53 definer functions in this project — the credit
engine, the vault, the materializer, the webhook's ledger writes — read zero
rows from tables they own and write nothing. The migrations still apply
cleanly. The schema is simply inert.

This was invisible to every test in this repository for the whole of its life,
because a superuser bypasses RLS unconditionally: CI has only ever exercised
the one configuration in which the question cannot arise.
`scripts/db-push-check.sh` now *demonstrates* the mechanism rather than
asserting it — it builds a throwaway FORCE-RLS table and a definer function
over it, owned by the deploy role, and shows the count go 1 → 0 when the
attribute is removed.

If the check above returns `bypasses_rls = f`, **do not deploy**. The fix is a
platform-level role attribute, not a migration; raise it with Supabase support
rather than working around it by dropping `FORCE`, which would weaken every
tenant boundary in the product to make a deploy succeed.

## When a migration needs something new

CI fails with the offending statement and the privilege it wanted. Then:

1. add the grant to `scripts/local-stack/platform-roles.sql`,
2. add a row to the table above and to the SQL block,
3. say in the PR that the deploy role now needs it.

Do not add it to a migration. A migration cannot grant itself a privilege it
needs in order to run.
