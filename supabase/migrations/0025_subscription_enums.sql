-- 0025 — enum values for subscription correctness (review H9, H11, and two
-- defects found revalidating the backlog against HEAD)
--
-- Values only, and nothing else. Postgres will not let a new enum value be
-- USED in the transaction that adds it, so every reference lives in 0026.
-- 0022 exists for the same reason and says so; this file must stay as thin.
--
-- One-way doors: Postgres has no DROP VALUE. Each of these is a state the
-- system can genuinely reach and has no way to record today.

-- A cancelled subscription is currently silent. The webhook writes
-- subscription_status='cancelled' and tells nobody, so the operator finds out
-- when a client asks why their walks stopped.
alter type notification_type add value if not exists 'subscription_cancelled';

-- Stripe subscriptions can be changed from the Stripe dashboard, outside
-- change-plan's intent flow. Today that silently diverges plans.stripe_price_id
-- from the live subscription.
alter type notification_type add value if not exists 'plan_changed_externally';

-- The counterpart to payment_failed. An off-session overage charge succeeds
-- without the client present, so the only evidence they have that money left
-- their card is the card statement.
alter type notification_type add value if not exists 'payment_taken';
