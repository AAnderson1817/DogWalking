-- 0034 — a failed payment that was later paid stops asking for attention.
--
-- Review M3. `invoice.payment_failed` writes a `failed` row, and nothing ever
-- resolved it. When the client updated their card and the invoice paid, the
-- succeeded row landed beside the failed one and BOTH stayed forever: the
-- Money screen showed $90 in "Collected" and $90 in "Needs attention" for one
-- invoice that is fully settled. The operator's only options were to remember
-- which failures were stale, or to chase a client who has already paid.
--
-- (The review also describes one failed row PER dunning retry, which would
-- make that $270. That half is already fixed — `hasFailedPaymentForInvoice`
-- dedupes the retries, added in the overage-taxonomy work. What was left is
-- one stale row per invoice, which is smaller and just as permanent.)
--
-- ── Why a column and not a `superseded` payment status ────────────────────
--
-- The obvious modelling is a new `payment_status` enum value. It is a trap
-- here, and this repository has already paid for it once:
-- `uq_payments_subscription_invoice` and `uq_overage_payment_per_walk` are
-- PARTIAL indexes filtered on `status`, so moving a row to a status outside
-- that filter drops it out of its own uniqueness guarantee. That is exactly
-- the double-grant hole 0023 had to close for `refunded`. A new status would
-- reopen it in a new shape.
--
-- A nullable timestamp also keeps more truth: the attempt genuinely DID fail,
-- and `status = 'failed'` is the honest record of that. What changes is
-- whether it still needs anybody's attention.

alter table payments add column superseded_at timestamptz;

comment on column payments.superseded_at is
  'Set when a later succeeded payment settled the same invoice or walk. The row keeps status=''failed'' — it did fail — but no longer counts as needing attention (review M3).';

-- Partial: the only query that cares is "unresolved failures", and that is a
-- small slice of a table that grows with every walk.
create index idx_payments_unresolved_failures
  on payments (operator_id, created_at desc)
  where status = 'failed' and superseded_at is null;

-- ── One writer, so no future caller can forget ────────────────────────────
-- A trigger rather than an edit to `fn_apply_invoice_paid` and a second edit
-- to the overage path. Both write a succeeded row, and a third writer will
-- exist eventually; a rule that lives at the table cannot be forgotten by code
-- that has not been written yet.
create function fn_supersede_settled_failures() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'succeeded' then
    return new;
  end if;

  -- Subscription: same invoice. Scoped by operator as well, because
  -- stripe_invoice_id comes from a Connect webhook and every other lookup in
  -- that handler is operator-scoped for the same reason (review B5).
  if new.stripe_invoice_id is not null then
    update payments
       set superseded_at = now()
     where operator_id = new.operator_id
       and stripe_invoice_id = new.stripe_invoice_id
       and status = 'failed'
       and superseded_at is null
       and id <> new.id;
  end if;

  -- Overage: same walk. A walk is charged as a whole (invariant 3), so a
  -- succeeded overage row settles every earlier failed attempt on that walk.
  if new.walk_id is not null and new.type = 'overage' then
    update payments
       set superseded_at = now()
     where operator_id = new.operator_id
       and walk_id = new.walk_id
       and type = 'overage'
       and status = 'failed'
       and superseded_at is null
       and id <> new.id;
  end if;

  return new;
end $$;

revoke all on function fn_supersede_settled_failures() from public, anon, authenticated;

create trigger trg_payments_supersede_failures
  after insert on payments
  for each row execute function fn_supersede_settled_failures();

-- ── Backfill, and why this one is safe to do ─────────────────────────────
-- 0023 deliberately did NOT backfill `stripe_invoice_id` on the ledger,
-- because a best-effort parse would have made guessed rows indistinguishable
-- from traced ones. This backfill is the opposite case: the link already
-- exists in the data. A failed row is superseded if and only if a succeeded
-- row shares its invoice id (or its walk, for overage) — no inference, no
-- reconstruction, and the same predicate the trigger uses going forward.
update payments f
   set superseded_at = s.created_at
  from payments s
 where f.status = 'failed'
   and f.superseded_at is null
   and s.status = 'succeeded'
   and s.operator_id = f.operator_id
   and s.id <> f.id
   and (
     (f.stripe_invoice_id is not null and s.stripe_invoice_id = f.stripe_invoice_id)
     or (f.type = 'overage' and s.type = 'overage'
         and f.walk_id is not null and s.walk_id = f.walk_id)
   );

do $$
declare v_left int;
begin
  select count(*) into v_left
    from payments f
   where f.status = 'failed' and f.superseded_at is null
     and exists (
       select 1 from payments s
        where s.status = 'succeeded' and s.operator_id = f.operator_id and s.id <> f.id
          and ((f.stripe_invoice_id is not null and s.stripe_invoice_id = f.stripe_invoice_id)
            or (f.type = 'overage' and s.type = 'overage'
                and f.walk_id is not null and s.walk_id = f.walk_id)));
  if v_left <> 0 then
    raise exception '0034: % settled failures were not superseded by the backfill', v_left;
  end if;
  raise notice '0034: settled failures no longer need attention';
end $$;
