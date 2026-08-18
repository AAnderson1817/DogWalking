# Rotating the vault key

The vault key encrypts every door code, lockbox combination and alarm sequence
in the product. This is how to replace it without anyone losing access, and how
to recover if something goes wrong halfway.

Before this existed the honest answer to "how do you rotate the vault key" was
"we cannot" — the stored blobs recorded nothing about which key wrote them, so
two keys could never coexist (review B2).

---

## Read this first: is this a key incident or a data incident?

Getting this wrong is the worst outcome of the night, so decide before you touch
anything.

**A leaked key alone is not a breach of the secrets.** An attacker also needs
the ciphertext, which requires database access — the service-role key or a
Postgres credential. If only the vault key leaked, rotating it closes the
exposure.

**If the key AND database access both leaked, assume every stored code is
known.** Rotating protects future reads only. The physical codes have to be
changed and the clients told. A rewrap that finishes green must never be
mistaken for that.

---

## What makes this safe

Two keys are loaded at once. Every blob names the key that wrote it, so during a
rotation some rows are on the new key and some on the old, and **both read
correctly**. That means:

- there is no outage window and no deadline;
- the rewrap can be paused, killed, or left half-done indefinitely;
- resuming is just running it again — the work queue is the data itself
  (`key_id <> current`), so there is no journal or cursor to get out of step.

The one thing you must not do while rows are mixed is **retire the old key**,
and that step is gated on a census that proves nothing is left on it.

---

## Rotating

### 1. Generate the new key

On your own machine — **never in the SQL Editor**:

```
openssl rand -base64 32
```

or, browser only, in the devtools console:

```js
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
```

### 2. Escrow it before anything else

Put it in your password manager, labelled with the environment. GitHub will
never show it to you again. If you set the secret first and lose the clipboard,
you now own a key you cannot read and cannot rotate away from.

### 3. Set both secrets

GitHub → Settings → Environments → the environment:

| secret | value |
|---|---|
| `VAULT_MASTER_KEY` | the **new** key |
| `VAULT_MASTER_KEY_PREVIOUS` | the **old** key, from escrow |

If the old key exists only in GitHub and never went into escrow, you cannot do
this — see *Recovering* below.

### 4. Deploy

Run the deploy workflow with `sync_secrets` enabled. It pushes the secrets,
deploys the functions, then calls `vault-rekey/verify`, which decrypts the
canary with the key actually loaded in the running function.

If verify fails with `key_mismatch`, **stop**. `VAULT_MASTER_KEY` cannot read
this project's data. Do not rewrap. Put the previous key back as
`VAULT_MASTER_KEY`, or supply the correct one, and deploy again. Nothing has
been modified at this point.

### 5. Rewrap

Call the function until nothing is left. Each call handles a batch and is safe
to repeat:

```bash
curl -sS -X POST "https://$PROJECT_REF.supabase.co/functions/v1/vault-rekey" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"rekey","batch":50}'
```

Each response reports `rewrapped`, `conflicts`, `unreadable` and `remaining`.
Repeat while `remaining > 0`.

- **`conflicts`** are not errors. An operator rotated that credential while you
  were working; their newer secret won, which is correct.
- **`unreadable`** lists rows encrypted under a key the deployment does not
  hold. They stay in the queue and are reported every run. They are *not*
  recorded as dead — supply the missing key as `VAULT_MASTER_KEY_PREVIOUS` and
  they recover on the next pass.

### 6. Check before retiring

```bash
curl -sS -X POST ".../vault-rekey" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d '{"action":"status"}'
```

Retire only when the census satisfies **both**:

```
census.on_other == 0  AND  census.total == census.on_primary + census.unreadable
```

The second condition is not redundant. `on_other == 0` is also true when the
query can see nothing at all — a permissions mistake, a `search_path` surprise,
an empty result. Checking that the parts add up to the whole is what stops the
gate green-lighting a retirement that would make every secret unreadable.

If `unreadable > 0`, do not retire. Find out what those rows are first.

### 7. Retire the old key

Set `VAULT_MASTER_KEY_PREVIOUS` to the literal string `none` and deploy again.
`none` is an explicit tombstone; an absent variable could equally mean a
mistyped secret name.

Keep the retired key in escrow for a while anyway. It costs nothing and it is
the only thing that can read a blob you did not know about.

### 8. Record it

| Environment | Key id | Rotated | By |
|---|---|---|---|
| staging | _pending_ | | |
| production | _pending_ | | |

The key id is in every `verify` and `status` response. It is derived from the
key, so it is safe to write down — it identifies the key without revealing it.

---

## Recovering

**The key is lost and there is no escrow copy.** Every stored secret is
unreadable, permanently. There is no cryptographic way back. The recovery is
operational: the operator re-collects codes from clients and re-enters them.
`verify` will report `key_mismatch` and `status` will show every row as
`unreadable`. This is the scenario escrow exists to prevent, and it is why
step 2 comes before step 3.

**A wrong key was deployed.** No data has changed — a wrong key cannot rewrite
anything, because the rewrap only runs when you invoke it, and `verify` fails
first. Put the right key back and deploy.

**A rewrap stopped halfway.** Nothing is broken. Both keys are deployed, every
row reads, and re-running continues from where the data actually is. Do not
retire the old key until step 6 passes.

**The old key is gone but rows still need it.** Those rows report as
`unreadable` and stay in the queue forever. If the key genuinely cannot be
recovered, those specific credentials must be re-entered by the operator; the
rest of the vault is unaffected.

---

## What is deliberately not automated

Retirement is a separate, manual act. It is the only irreversible step, and the
gate protecting it is a census — so it should be run by someone who has read
the numbers, not by a workflow that ran them.
