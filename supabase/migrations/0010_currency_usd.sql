-- 0010: currency switch GBP → USD (operator request, staging bring-up).
-- Money stays integer minor units; the *_pence column names are kept for
-- stability and now hold cents (documented in CLAUDE.md + spec 01).
alter table operators alter column currency set default 'USD';
alter table payments alter column currency set default 'USD';
update operators set currency = 'USD' where currency = 'GBP';
update payments set currency = 'USD' where currency = 'GBP';
