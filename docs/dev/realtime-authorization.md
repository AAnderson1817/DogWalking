# Realtime authorization — the one step that is not in this repository

Migration `0020` and the `private: true` config on both sides close the
live-GPS channel for *our* client. They do not close it for everyone else.
This page is the remaining step, why code cannot do it, and how to check it.

## What the code already does

- `realtime.messages` policies scope topic `walk:{uuid}` to the walk's
  operator (receive + send) and its client (receive only) — migration
  `0020_realtime_walk_channel_authorization.sql`.
- `useWalkChannel` opens the channel with `{ config: { private: true } }`.
- `_lib/broadcast` publishes with `private: true`.
- `smoke.sql` asserts the full matrix, and CI fails a channel that is not
  private or a `supabase.channel()` call anywhere else.

## What it cannot do

Supabase applies authorization **only to private channels**. A third party can
still open `walk:{uuid}` as a *public* channel — `private` defaults to false —
and the policies above never run. Closing that is a project-level setting:

> Realtime → Settings → **Allow public access** → off

There is no `[realtime]` public-access key in `supabase/config.toml`, and
neither `deploy-staging.yml` nor `deploy-production.yml` runs
`supabase config push`, so nothing in this repository can set it or assert it.
(That structural gap is review finding H2 and is tracked separately — every
auth setting in `config.toml` governs `supabase start` on a laptop and nothing
else.)

## Steps

Do staging first and leave it for a day of normal use before touching
production.

1. Supabase dashboard → the project → **Realtime** → **Settings**.
2. Turn **Allow public access** off.
3. Confirm live GPS still works end to end (below). If it breaks, turn the
   setting back on — that restores the previous behaviour immediately — and
   open an issue rather than leaving it half-applied.

## Verifying it worked

**The positive case — this must still work.** With the setting off:

1. Sign in as an operator, start a walk, and let it record a few points.
2. In another browser, sign in as that walk's client and open the walk.
3. The client's map should keep receiving points, and should show the walk as
   ended within a second or two of the operator ending it.

If either stops, the policies are wrong for a real JWT — not the toggle. Check
the Realtime logs for an authorization error naming the topic.

**The negative case — this must now fail.** From a browser console on any
page, with only the anon key (no session):

```js
const { createClient } = supabase            // the CDN global, or your own client
const c = createClient(PROJECT_URL, ANON_KEY)

// Public join: this is what used to work.
c.channel('walk:<a real walk uuid>')
 .on('broadcast', { event: 'gps' }, console.log)
 .subscribe(console.log)
```

Before the toggle: `SUBSCRIBED`, and GPS fixes for a live walk stream into the
console. After: the join is refused. A `CHANNEL_ERROR` or a closed socket is
the pass condition here.

Then the write side, which is the worse half — it is what let a third party
fabricate or terminate a client's proof of service:

```js
c.channel('walk:<a real walk uuid>')
 .subscribe(s => s === 'SUBSCRIBED' &&
   c.channel('walk:<same uuid>').send({ type: 'broadcast', event: 'ended', payload: {} }))
```

After the toggle this must not reach any subscriber.

Use a walk uuid from *staging*, and do not paste a production walk id into a
console or a ticket — a walk uuid was never an authorization control, but it
is still the address of a named person at a named home.

## When this is done

Record the date and the project here, so the next person can tell "off" from
"never checked":

| Project | Allow public access | Verified by | Date |
|---|---|---|---|
| staging | _pending_ | | |
| production | _pending_ | | |
