-- 0022 — enum values for payment reversal (review B4)
--
-- Split from 0023 on purpose. Postgres will not let a new enum value be USED
-- in the same transaction that adds it, so the values land here and every
-- reference to them lives in the next migration. This file therefore adds
-- values and does nothing else — it must stay that way.
--
-- Note that these are one-way doors: Postgres has no DROP VALUE. Each of the
-- three below is a state the system can genuinely be in and has no way to
-- record today.

-- 'refunded' already existed and was never written by any code path: the
-- status was declared in 0001, filtered for on the Money screen and styled by
-- status-treatment.ts, while no line in the repository ever set it. A dispute
-- is a distinct state from a refund — the money is pulled by the cardholder's
-- bank rather than returned by the operator, it can be contested, and it
-- carries a fee — so it gets its own value rather than being folded in.
alter type payment_status add value if not exists 'disputed';

-- The operator learns about a refund or a dispute today only if they happen
-- to read Stripe's email. These make it reach the notification bell.
alter type notification_type add value if not exists 'payment_refunded';
alter type notification_type add value if not exists 'payment_disputed';
