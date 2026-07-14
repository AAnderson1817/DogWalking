-- 0011: business timezone switch Europe/London → America/Chicago (operator
-- request). The 0008 cancellation-cutoff guard reads operators.timezone per
-- row, so existing and future operators get Central automatically; the
-- 'Europe/London' coalesce fallback in 0008 stays (unreachable — the column
-- is not null).
alter table operators alter column timezone set default 'America/Chicago';
update operators set timezone = 'America/Chicago' where timezone = 'Europe/London';
