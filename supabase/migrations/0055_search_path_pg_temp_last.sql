-- 0055 — every function that pins a search_path pins `public, pg_temp`.
--
-- Backlog item 1, from PR B's review. PostgreSQL searches the session's
-- temporary schema FIRST for tables and types unless `pg_temp` is listed in
-- the search_path, and PUBLIC holds TEMP by default. So a definer function
-- whose path is `public` alone reads whatever temp table a caller has made
-- with the name of a table it uses, and reads it as its owner. Measured on
-- `my_client_id()`: a temp `clients` shadowed `public.clients` inside it.
-- Listing `pg_temp` last, the form PostgreSQL's documentation recommends for
-- a definer function, searches temp tables after everything else, whatever
-- TEMP is granted. Functions are never looked up in `pg_temp`, so this is
-- about tables and types only.
--
-- Not reachable through the product: `anon` and `authenticated` are NOLOGIN,
-- PostgREST issues no DDL, and no function an API role can execute runs
-- dynamic SQL. This is a hardening, not a fix for an observed path.
--
-- ── What changes ─────────────────────────────────────────────────────────
--
-- `ALTER FUNCTION … SET search_path` rewrites one entry of `proconfig` and
-- nothing else. The body, the signature, the owner, SECURITY DEFINER, the
-- volatility and the ACL are untouched, which is why this is 77 ALTERs and
-- not 77 `create or replace` statements rebuilt from old text (the 0040
-- lesson: a replacement written from an older body silently deletes what a
-- later migration added). Name resolution changes in exactly one way:
-- `public` and `pg_catalog` resolve as before, and a temp table or type can
-- no longer come first. No function here uses a temp table on purpose.
--
-- Which functions: every function in `public`, outside extensions, that pins
-- `search_path = public`. That is the 73 definer functions that had not moved
-- (0054's three already set `public, pg_temp`), and four invoker functions
-- that pin a path of their own: when a definer calls one, it runs as the
-- definer's owner with that pinned path. The five invoker functions that pin
-- none are left alone: they inherit their caller's path, which inside a
-- definer function is now this one.
--
-- ── What checks it ───────────────────────────────────────────────────────
--
-- Each ALTER fails on a signature that does not exist, so a list that has
-- drifted from the schema refuses to apply. There is no DO-block assertion
-- here: the enum catalogue's reader refuses a procedural body that mentions
-- `search_path`, on purpose, because a body is where it cannot see a change
-- of path. The standing guard is smoke's invariant-5 block, which now fails
-- any definer function without exactly `public, pg_temp`, and any function
-- that pins another path, including one a later migration adds.
--
-- ── What this does not do ───────────────────────────────────────────────
--
-- `revoke temporary on database … from public`, the other half of the
-- backlog item. It closes the same door from the other side, but only once
-- it is measured on a real project that nothing the platform runs needs a
-- temporary table as an API role; nothing here can measure that.

-- ── The definer functions (73) ───────────────────────────────────────────
alter function fn_account_has_password(uuid) set search_path = public, pg_temp;
alter function fn_adjust_credits(uuid,integer,text) set search_path = public, pg_temp;
alter function fn_apply_invoice_paid(uuid,integer,text,integer,text,text,boolean) set search_path = public, pg_temp;
alter function fn_apply_plan_change_intent(uuid,text) set search_path = public, pg_temp;
alter function fn_apply_rollover(uuid) set search_path = public, pg_temp;
alter function fn_apply_topup(uuid,integer,text,integer) set search_path = public, pg_temp;
alter function fn_assert_plan_change_intent_tenant() set search_path = public, pg_temp;
alter function fn_assert_tenant_consistency() set search_path = public, pg_temp;
alter function fn_block_invite_log_mutation() set search_path = public, pg_temp;
alter function fn_book_walk(uuid,uuid,date,time without time zone,time without time zone,uuid[]) set search_path = public, pg_temp;
alter function fn_cancel_paused_walks() set search_path = public, pg_temp;
alter function fn_change_plan(uuid,uuid,numeric) set search_path = public, pg_temp;
alter function fn_claim_invite(uuid,text) set search_path = public, pg_temp;
alter function fn_claim_notification_send(uuid,text,interval) set search_path = public, pg_temp;
alter function fn_client_email_suppressed(uuid) set search_path = public, pg_temp;
alter function fn_deactivate_schedule(uuid,date) set search_path = public, pg_temp;
alter function fn_debit_walk(uuid) set search_path = public, pg_temp;
alter function fn_email_suppressed(text,uuid,notification_type) set search_path = public, pg_temp;
alter function fn_expire_credits() set search_path = public, pg_temp;
alter function fn_expire_notification_backlog(interval,integer) set search_path = public, pg_temp;
alter function fn_export_client_data(uuid) set search_path = public, pg_temp;
alter function fn_forget_purged_push_subscriptions() set search_path = public, pg_temp;
alter function fn_grant_credits(uuid,integer,text) set search_path = public, pg_temp;
alter function fn_grant_cycle_credits(uuid,integer,text,text) set search_path = public, pg_temp;
alter function fn_guard_clients_update() set search_path = public, pg_temp;
alter function fn_guard_pets_update() set search_path = public, pg_temp;
alter function fn_guard_properties_update() set search_path = public, pg_temp;
alter function fn_guard_walks_client_update() set search_path = public, pg_temp;
alter function fn_invite_signup_allow_attempt(uuid,inet,integer,integer) set search_path = public, pg_temp;
alter function fn_invite_signup_check(uuid,text) set search_path = public, pg_temp;
alter function fn_job_health(interval) set search_path = public, pg_temp;
alter function fn_ledger_apply() set search_path = public, pg_temp;
alter function fn_log_credential_action(uuid,uuid,credential_action,text,text,text,uuid) set search_path = public, pg_temp;
alter function fn_materialize_walks(integer) set search_path = public, pg_temp;
alter function fn_note_push_failure(uuid,text) set search_path = public, pg_temp;
alter function fn_notification_backlog(interval,integer) set search_path = public, pg_temp;
alter function fn_notify_low_credit(uuid) set search_path = public, pg_temp;
alter function fn_notify_walk_changes() set search_path = public, pg_temp;
alter function fn_operator_can_charge(uuid) set search_path = public, pg_temp;
alter function fn_preview_invite(uuid) set search_path = public, pg_temp;
alter function fn_price_unpriced_scheduled_walks() set search_path = public, pg_temp;
alter function fn_purge_client(uuid) set search_path = public, pg_temp;
alter function fn_purge_client_photos(uuid) set search_path = public, pg_temp;
alter function fn_read_credential(uuid,text,uuid,text,text,uuid) set search_path = public, pg_temp;
alter function fn_record_plan_change_intent(uuid,uuid,uuid,uuid,uuid,text,numeric) set search_path = public, pg_temp;
alter function fn_refund_cancelled_debit() set search_path = public, pg_temp;
alter function fn_register_push_subscription(text,text,text,text) set search_path = public, pg_temp;
alter function fn_remove_push_subscription(text) set search_path = public, pg_temp;
alter function fn_reset_invite_signup_budget() set search_path = public, pg_temp;
alter function fn_reverse_payment(uuid,text,integer,text) set search_path = public, pg_temp;
alter function fn_revoke_credential(uuid,uuid,text,text) set search_path = public, pg_temp;
alter function fn_revoke_invite(uuid) set search_path = public, pg_temp;
alter function fn_rotate_credential(uuid,uuid,bytea,entry_method,text,text,text) set search_path = public, pg_temp;
alter function fn_rotate_invite(uuid) set search_path = public, pg_temp;
alter function fn_run_nightly_jobs(integer) set search_path = public, pg_temp;
alter function fn_seed_operator_defaults() set search_path = public, pg_temp;
alter function fn_set_schedule_pets(uuid,uuid[]) set search_path = public, pg_temp;
alter function fn_snapshot_walk_price() set search_path = public, pg_temp;
alter function fn_supersede_settled_failures() set search_path = public, pg_temp;
alter function fn_sweep_abandoned_walks(integer) set search_path = public, pg_temp;
alter function fn_sweep_gps_retention() set search_path = public, pg_temp;
alter function fn_unbind_invite(uuid) set search_path = public, pg_temp;
alter function fn_unsubscribe_by_token(uuid) set search_path = public, pg_temp;
alter function fn_vault_allow_attempt(uuid,inet,integer,integer) set search_path = public, pg_temp;
alter function fn_vault_census(text) set search_path = public, pg_temp;
alter function fn_vault_rewrap_apply(uuid,bytea,bytea,text) set search_path = public, pg_temp;
alter function fn_vault_rewrap_batch(text,integer) set search_path = public, pg_temp;
alter function fn_vault_set_canary(bytea) set search_path = public, pg_temp;
alter function fn_walk_channel_access(text,boolean) set search_path = public, pg_temp;
alter function fn_walk_cost(uuid) set search_path = public, pg_temp;
alter function fn_write_credential(uuid,uuid,uuid,entry_method,bytea,text,text,text) set search_path = public, pg_temp;
alter function is_operator() set search_path = public, pg_temp;
alter function my_client_id() set search_path = public, pg_temp;

-- ── Invoker functions that pin a path of their own (4) ───────────────────
alter function fn_client_facing_notification_types() set search_path = public, pg_temp;
alter function fn_credential_log_block_mutation() set search_path = public, pg_temp;
alter function fn_is_push_service_endpoint(text) set search_path = public, pg_temp;
alter function fn_is_service_session() set search_path = public, pg_temp;
