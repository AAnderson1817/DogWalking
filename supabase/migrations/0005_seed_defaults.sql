-- 0005 — schema-level defaults: storage buckets (spec 01)
-- Both buckets are private; all client-facing reads go through signed URLs.

insert into storage.buckets (id, name, public)
values
  ('pet-photos', 'pet-photos', false),
  ('walk-photos', 'walk-photos', false)
on conflict (id) do nothing;
