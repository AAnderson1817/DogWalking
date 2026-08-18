# Disaster recovery

What to do when the database is wrong and you need it to be right again.

This document exists because the repository had no occurrence of the words
"restore", "rollback", "PITR" or "incident" anywhere, against 21 append-only
migrations with no reverse path (review B3). `credit_ledger` and `payments`
are the authoritative record of money owed and money taken; losing a day of
them means reconciling against Stripe by hand.

> **Read the honesty note first.** Sections 1–4 are procedures that have been
> written, not procedures that have been rehearsed. **RTO and RPO are
> currently UNMEASURED.** Section 6 is the rehearsal that turns the numbers in
> this file from estimates into measurements, and until it has been run, every
> figure below is an expectation. A disaster-recovery plan nobody has executed
> is a document, not a capability — the distinction matters more here than
> anywhere else in the repository, because the first execution would otherwise
> happen on the worst day.

## 0. What protection actually exists

| Layer | Protection | Granularity | Notes |
|---|---|---|---|
| Postgres — Free tier | **none** | — | No backups at all. Projects also pause after ~1 week idle. |
| Postgres — Pro | Daily backup | 24 h | The whole of `production-cutover.md`'s DR posture was this one line. |
| Postgres — Pro + PITR add-on | Continuous WAL | ~2 min | Paid add-on. **Not enabled.** |
| Storage (`walk-photos`, `pet-photos`) | **none at any tier** | — | Objects are not covered by the database backup. |
| Migrations | Append-only, forward-only | — | Invariant 6. There are no down migrations, by design. |
| Edge functions | Redeployable from git | — | Stateless; `supabase functions deploy` restores them. |
| Edge secrets | GitHub environment secrets | — | Re-pushable via the deploy workflow's `sync_secrets`. |
| Nightly job schedule | Migration `0028` | — | Was a hand-typed dashboard entry that no restore recreated (H15). `db push` now restores it, and `fn_job_health()` says whether it is running. |
| Vault master key | **one copy** unless escrowed | — | See `vault-key-rotation.md`. A lost key is unrecoverable data. |

The two rows that read **none** are the ones to fix first, and both are
decisions rather than code — see section 7.

## 1. Decide what kind of wrong it is

Recovery differs completely by cause. Establish this before touching anything.

| Symptom | Likely cause | Go to |
|---|---|---|
| A migration applied and the schema is wrong | Bad migration | §2 |
| Rows are wrong but the schema is fine | Bad data write | §3 |
| Whole project is unreachable / deleted | Platform or account | §4 |
| Photos missing, walk rows fine | Storage divergence | §5 |
| Door codes return `key_mismatch` | Vault key, not data | `vault-key-rotation.md` |

**Do not** reach for a restore reflexively. A restore rolls back *everything*,
including the walks completed and the money taken since the restore point. For
a bad migration that has not yet corrupted data, a forward fix is both faster
and lossless.

## 2. A bad migration

Migrations are append-only (invariant 6) and there are no down migrations. The
rollback is a **new migration that forward-corrects**, exactly as `0019` did
for the phantom `active` column in `fn_book_walk`.

1. **Stop the bleeding.** If the migration broke a write path, the damage is
   still accruing. Note the time it was applied — that is your restore point
   if you end up in §3.
2. **Do not edit the applied migration file.** CI's `Migrations — append-only`
   job fails the PR, and the remote schema would silently disagree with the
   file anyway.
3. Write `00NN_fix_<what>.sql`. For a function, `create or replace` with a
   byte-identical signature, `security definer` and `search_path` — a diff of
   exactly the broken predicate is the reviewable ideal.
4. **Add the test that would have caught it.** `0019`'s smoke block asserts the
   *specific* rejection message for each failure case, because the file's usual
   "anything non-`FAIL:` passes" idiom would have passed against the broken
   function: a call dying of `undefined_column` is indistinguishable from one
   correctly refused.
5. Merge. Staging deploys automatically; production needs the gated workflow.

**A migration that has already destroyed data is not a §2 problem.** Forward-fix
the schema, then §3 for the rows.

## 3. Bad data, good schema

This is the case backups are actually for, and the one where the current
posture is thinnest.

### With PITR (not currently enabled)

Restore to a timestamp just before the bad write. Dashboard → Database →
Backups → Point in time. Recovery is to a **new** project or in place
depending on the plan; confirm which before starting, because in-place is
destructive.

### With daily backups only (Pro)

You lose everything since the last nightly. Before restoring, weigh it:

- **What you get back**: correct rows as of the backup.
- **What you lose**: every walk completed, credit debited, cycle grant and
  overage charge since. Stripe still has all of it — Stripe is *not* rolled
  back — so the two records now disagree, in the direction of "we charged for
  things the database does not know about".
- **The reconciliation** is `payments` and `credit_ledger` against the Stripe
  dashboard for the lost window, by hand. `stripe_events` is a claim ledger
  keyed on the Stripe event id, so replaying the missed webhooks is the
  mechanical part; the walks completed offline are not.

Often the better answer for a narrow fault is a **targeted repair** — a
`SECURITY DEFINER` correction function with a per-client row lock, adjusting
only the affected rows — rather than rolling the whole database back a day.
Credit corrections must still go through the ledger (invariant 1): never
`UPDATE clients.credit_balance`, insert a compensating ledger entry.

### With neither (Free tier)

There is no recovery. This is why the tier decision in section 7 is the first
item and not the last.

## 4. Project loss

1. Create a new project (same region).
2. `supabase db push` from the repository — migrations `0001…` rebuild the
   entire schema, RLS, functions and grants. This path is exercised on every
   CI run, so it is the one part of recovery that is continuously tested.
3. Restore data from the most recent backup.
4. Push edge secrets: run the deploy workflow with **`sync_secrets` ticked**.
   `VAULT_MASTER_KEY` must be the *same key* the ciphertext was written with —
   a fresh key makes every stored door code permanently unreadable, and the
   deploy's `Verify the vault key opens this project` step is what tells you
   so before a client does.
5. Redo the dashboard wiring that no file in this repository can set: the
   `send-notification` database webhook, the Realtime **"Allow public
   access"** toggle (issue #24), and the Stripe webhook endpoint URL, which
   now points at the old project ref.

   The nightly cron is **no longer on this list** — step 2 restores it, because
   migration `0028` owns the schedule. That is the point of moving it there:
   this list used to include it, and it is a list whose every item fails
   silently. If `db push` reports *"pg_cron is not installed"*, enable the
   extension and re-run; the migration asserts rather than skipping, so it
   cannot leave you with a project that deployed cleanly and schedules nothing.
6. Re-point `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in Vercel.
7. Confirm the nightly job actually runs: `select * from fn_job_health();`
   reads `stale = true` immediately after a rebuild and must read `false`
   after the next 03:00 UTC. The `Nightly job health` workflow asks the same
   question daily and goes red when the answer is wrong.

Step 5 is the one that gets forgotten, and every item in it fails silently:
emails stop sending, and the Realtime stream goes back to being
world-readable.

## 5. Storage divergence

Storage objects are **not** covered by the database backup, so any database
restore desynchronises them from `walk_photos` / pet photos:

- **Dangling rows** — the row was restored, the object was never in the backup
  because objects are not backed up at all. The report card shows a broken
  image.
- **Orphaned objects** — uploaded after the restore point; the row is gone, the
  bytes remain and nothing references them.

Today you can enumerate both by diffing the bucket listing against
`walk_photos.storage_path`. What you **cannot** do is verify that a surviving
object is still the one that was uploaded: the table records no checksum and no
byte size. For the photo report — the artefact you would submit in a chargeback
dispute — "the file is present" is a weaker claim than it looks. See section 7.

## 6. The rehearsal (this is what makes the numbers real)

Until this has been run, sections 1–5 are untested. Budget an hour.

1. Create a scratch Supabase project. Do **not** use staging: the point is to
   rehearse recovery, and rehearsing on the environment you would recover
   *from* proves nothing.
2. `supabase db push` against it, then `supabase/seed.sql`.
3. **Start a stopwatch.** Simulate the disaster: delete the project, or apply a
   destructive statement against the ledger.
4. Recover by following §4 without improvising. Every place you have to
   improvise is a defect in this document — fix it in the same session.
5. **Stop the stopwatch.** That is your **RTO**.
6. Note the age of the newest recoverable write. That is your **RPO**.
7. Record both in the table below, with the date, and delete the honesty note
   at the top of this file — it has earned its removal.

| Rehearsed on | RTO (measured) | RPO (measured) | Notes |
|---|---|---|---|
| _never_ | **unmeasured** | **unmeasured** | Section 6 has not been run. |

## 7. Open decisions

These are the parts of B3 that no amount of code in this repository can close.
Each costs money, a credential, or both.

1. **Supabase plan tier.** Free has no backups and pauses when idle; both are
   disqualifying before a first paying client. Pro (~$25/mo) buys daily
   backups — a 24-hour RPO on the money tables.
2. **PITR add-on.** Takes RPO from ~24 h to ~2 min. This is the single largest
   improvement available and the only one that makes §3 something other than a
   loss-weighing exercise.
3. **A Supabase management API token.** Lets the deploy workflow trigger an
   on-demand backup *before* `db push` and fail the deploy if it does not
   complete — so a bad migration is always at most minutes from a known-good
   point, independent of the nightly.
4. **Storage backup.** Objects have no protection at any tier. Mirroring both
   buckets to independent object storage needs a destination and credentials.
5. **A `walk_photos` integrity record.** Adding a client-computed SHA-256 and
   byte size at upload makes post-restore reconciliation possible in principle
   rather than impossible. Needs no money and no decision — it is a migration
   plus the upload path, and is the one item here that can simply be built.
6. **Vault key escrow.** One copy of `VAULT_MASTER_KEY` is a single point of
   unrecoverable loss. A second copy in a password manager costs nothing.
   `vault-key-rotation.md` § "Escrow it before anything else".

## Related

- `vault-key-rotation.md` — key custody, rotation, and `key_mismatch`
- `production-cutover.md` — first production stand-up
- `staging-setup.md` — staging project setup and deploy troubleshooting
