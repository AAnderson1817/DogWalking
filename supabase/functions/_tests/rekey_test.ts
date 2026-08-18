// vault-rekey: the deploy gate and the rotation loop (review B2).
//
// The happy path is the least interesting part. What these cover is the set of
// states a rotation can actually get into — interrupted, raced, run with the
// wrong key, run against a project that has never deployed — because a
// rotation that fails badly loses every door code in the product.
import { assert, assertEquals, assertRejects } from "./asserts.ts";
import {
  CANARY_PLAINTEXT,
  handleRekey,
  type Census,
  type RekeyDeps,
  type RekeyRow,
} from "../vault-rekey/handler.ts";
import { HttpError } from "../_lib/http.ts";
import {
  decryptSecret,
  encryptSecret,
  importVaultKey,
  VaultBlobError,
  type VaultBinding,
  type VaultKey,
} from "../_lib/crypto.ts";

function keyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s);
}

const OP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** A fake project: real crypto, a real key ring, an in-memory table. */
async function project(opts: { keys: VaultKey[]; rows?: Array<{ id: string; secret: string; key: VaultKey }> }) {
  const primary = opts.keys[0];
  const byId = new Map(opts.keys.map((k) => [k.id, k]));
  const table = new Map<string, { operator_id: string; ciphertext: Uint8Array }>();
  for (const r of opts.rows ?? []) {
    const binding: VaultBinding = { credentialId: r.id, operatorId: OP };
    table.set(r.id, { operator_id: OP, ciphertext: await encryptSecret(r.key, r.secret, binding) });
  }
  let canary: Uint8Array | null = null;
  const applyCalls: string[] = [];

  const keyIdOf = (blob: Uint8Array) => {
    if (blob.length < 37 || blob[0] !== 0x02) return null;
    let h = "";
    for (const b of blob.subarray(1, 9)) h += b.toString(16).padStart(2, "0");
    return h;
  };

  const census = (): Census => {
    let on_primary = 0, on_other = 0, unreadable = 0;
    for (const row of table.values()) {
      const kid = keyIdOf(row.ciphertext);
      if (kid === null) unreadable += 1;
      else if (kid === primary.id) on_primary += 1;
      else on_other += 1;
    }
    return { total: table.size, on_primary, on_other, unreadable };
  };

  const deps: RekeyDeps = {
    primaryKeyId: () => Promise.resolve(primary.id),
    heldKeyIds: () => Promise.resolve([...byId.keys()]),
    encrypt: (pt, binding) => encryptSecret(primary, pt, binding),
    decrypt: (blob, binding) => decryptSecret(byId, blob, binding),
    census: () => Promise.resolve(census()),
    readCanary: () => Promise.resolve(canary),
    setCanary: (blob) => {
      canary = blob;
      return Promise.resolve(keyIdOf(blob) ?? "");
    },
    rewrapBatch: (keyId, limit) => {
      const out: RekeyRow[] = [];
      for (const [id, row] of table) {
        if (keyIdOf(row.ciphertext) !== keyId && out.length < limit) {
          out.push({ id, operator_id: row.operator_id, ciphertext: row.ciphertext, key_id: keyIdOf(row.ciphertext) });
        }
      }
      return Promise.resolve(out);
    },
    applyRewrap: (id, expect, next, expectKeyId) => {
      applyCalls.push(id);
      const row = table.get(id);
      if (!row) return Promise.resolve(false);
      // Compare-and-swap, exactly as fn_vault_rewrap_apply does.
      if (row.ciphertext.length !== expect.length || !row.ciphertext.every((b, i) => b === expect[i])) {
        return Promise.resolve(false);
      }
      if (keyIdOf(next) !== expectKeyId) throw new Error("replacement under the wrong key");
      table.set(id, { ...row, ciphertext: next });
      return Promise.resolve(true);
    },
  };
  return { deps, table, census, applyCalls, setCanary: (b: Uint8Array | null) => { canary = b; }, getCanary: () => canary };
}

// ── verify: the deploy gate ───────────────────────────────────────────────

Deno.test("verify installs a pin on a project that has never deployed", async () => {
  const k = await importVaultKey(keyB64());
  const p = await project({ keys: [k] });
  const out = await handleRekey({ action: "verify" }, p.deps);
  assertEquals(out.canary, "installed");
  assertEquals(out.key_id, k.id);
  assert(p.getCanary(), "a pin should now exist");
  // Adopting can only ever bless the key the deployment is already using.
  assertEquals(await decryptSecret(new Map([[k.id, k]]), p.getCanary()!, {
    credentialId: "00000000-0000-0000-0000-000000000000",
    operatorId: "00000000-0000-0000-0000-000000000000",
  }), CANARY_PLAINTEXT);
});

Deno.test("verify passes when the deployed key matches the pin", async () => {
  const k = await importVaultKey(keyB64());
  const p = await project({ keys: [k] });
  await handleRekey({ action: "verify" }, p.deps);
  const out = await handleRekey({ action: "verify" }, p.deps);
  assertEquals(out.canary, "verified");
});

Deno.test("verify FAILS when the deployed key cannot read this project", async () => {
  // The scenario the whole design exists for: a mistyped or regenerated
  // secret. Before this, the first symptom was an operator at a front door.
  const original = await importVaultKey(keyB64());
  const p = await project({ keys: [original] });
  await handleRekey({ action: "verify" }, p.deps);
  const pinnedCanary = p.getCanary()!;

  const wrong = await importVaultKey(keyB64());
  const q = await project({ keys: [wrong] });
  q.setCanary(pinnedCanary);

  const err = await assertRejects(() => handleRekey({ action: "verify" }, q.deps));
  assert(err instanceof HttpError, "expected an HttpError");
  assertEquals(err.code, "key_mismatch");
  assertEquals(err.status, 409);
});

Deno.test("verify still passes while the pin is on the retired key", async () => {
  // Mid-rotation the pin may legitimately lag; reads work, so this must not
  // fail the deploy.
  const oldKey = await importVaultKey(keyB64());
  const newKey = await importVaultKey(keyB64());
  const p = await project({ keys: [oldKey] });
  await handleRekey({ action: "verify" }, p.deps);
  const pinned = p.getCanary()!;

  const q = await project({ keys: [newKey, oldKey] }); // new primary, old retained
  q.setCanary(pinned);
  const out = await handleRekey({ action: "verify" }, q.deps);
  assertEquals(out.canary, "verified");
  assertEquals(out.key_id, newKey.id);
});

// ── rekey: the rotation loop ──────────────────────────────────────────────

Deno.test("rekey moves rows onto the current key and is idempotent", async () => {
  const oldKey = await importVaultKey(keyB64());
  const newKey = await importVaultKey(keyB64());
  const rows = [
    { id: "11111111-1111-4111-8111-111111111111", secret: "door 1234", key: oldKey },
    { id: "22222222-2222-4222-8222-222222222222", secret: "alarm 99#", key: oldKey },
  ];
  const p = await project({ keys: [newKey, oldKey], rows });

  const first = await handleRekey({ action: "rekey" }, p.deps);
  assertEquals(first.rewrapped, 2);
  assertEquals(first.remaining, 0);

  // Running again is a no-op: the work queue IS the data, so a completed row
  // is simply not selected. No journal to get out of step.
  const second = await handleRekey({ action: "rekey" }, p.deps);
  assertEquals(second.batch, 0);
  assertEquals(second.rewrapped, 0);

  // And the secrets survived.
  const ring = new Map([[newKey.id, newKey]]);
  for (const r of rows) {
    const stored = p.table.get(r.id)!;
    assertEquals(
      await decryptSecret(ring, stored.ciphertext, { credentialId: r.id, operatorId: OP }),
      r.secret,
    );
  }
});

Deno.test("an interrupted rekey resumes exactly where it stopped", async () => {
  const oldKey = await importVaultKey(keyB64());
  const newKey = await importVaultKey(keyB64());
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `3333333${i}-3333-4333-8333-333333333333`,
    secret: `secret ${i}`,
    key: oldKey,
  }));
  const p = await project({ keys: [newKey, oldKey], rows });

  const partial = await handleRekey({ action: "rekey", batch: 2 }, p.deps);
  assertEquals(partial.rewrapped, 2);
  assertEquals(partial.remaining, 3);
  // Mixed state is a VALID state: every row still reads, on either key.
  const ring = new Map([[newKey.id, newKey], [oldKey.id, oldKey]]);
  for (const r of rows) {
    const stored = p.table.get(r.id)!;
    await decryptSecret(ring, stored.ciphertext, { credentialId: r.id, operatorId: OP });
  }

  await handleRekey({ action: "rekey", batch: 2 }, p.deps);
  const done = await handleRekey({ action: "rekey", batch: 2 }, p.deps);
  assertEquals(done.remaining, 0);
  assertEquals(p.census().on_primary, 5);
});

Deno.test("a row rotated by an operator mid-rekey is not clobbered", async () => {
  const oldKey = await importVaultKey(keyB64());
  const newKey = await importVaultKey(keyB64());
  const id = "44444444-4444-4444-8444-444444444444";
  const p = await project({ keys: [newKey, oldKey], rows: [{ id, secret: "stale", key: oldKey }] });

  // Simulate the operator changing the code between our read and our write:
  // the stored blob no longer matches what we decrypted.
  const original = p.deps.rewrapBatch;
  p.deps.rewrapBatch = async (kid, limit) => {
    const batch = await original(kid, limit);
    p.table.set(id, {
      operator_id: OP,
      ciphertext: await encryptSecret(newKey, "the NEW code", { credentialId: id, operatorId: OP }),
    });
    return batch; // stale rows, as if we had read them a moment earlier
  };

  const out = await handleRekey({ action: "rekey" }, p.deps);
  assertEquals(out.conflicts, 1, "the stale write must be refused");
  assertEquals(out.rewrapped, 0);
  // The operator's newer secret survived.
  assertEquals(
    await decryptSecret(new Map([[newKey.id, newKey]]), p.table.get(id)!.ciphertext, {
      credentialId: id,
      operatorId: OP,
    }),
    "the NEW code",
  );
});

Deno.test("a row whose key is not held is reported, never marked dead", async () => {
  const missing = await importVaultKey(keyB64());
  const current = await importVaultKey(keyB64());
  const id = "55555555-5555-4555-8555-555555555555";
  // Encrypted under a key this deployment does NOT hold.
  const p = await project({ keys: [current], rows: [{ id, secret: "unreachable", key: missing }] });

  const out = await handleRekey({ action: "rekey" }, p.deps);
  assertEquals(out.unreadable, [id]);
  assertEquals(out.rewrapped, 0);
  assertEquals(out.remaining, 1, "it stays in the queue");

  // Supply the missing key and the row recovers — which is precisely what a
  // journal recording it as permanently terminal would have prevented.
  const q = await project({ keys: [current, missing] });
  q.table.set(id, p.table.get(id)!);
  const recovered = await handleRekey({ action: "rekey" }, q.deps);
  assertEquals(recovered.rewrapped, 1);
  assertEquals(recovered.remaining, 0);
});

// ── status ────────────────────────────────────────────────────────────────

Deno.test("status reports a census whose arithmetic is checkable", async () => {
  const oldKey = await importVaultKey(keyB64());
  const newKey = await importVaultKey(keyB64());
  const p = await project({
    keys: [newKey, oldKey],
    rows: [
      { id: "66666666-6666-4666-8666-666666666666", secret: "a", key: newKey },
      { id: "77777777-7777-4777-8777-777777777777", secret: "b", key: oldKey },
    ],
  });
  const out = await handleRekey({ action: "status" }, p.deps);
  const c = out.census as Census;
  // The gate is not `on_other === 0` alone: that is also true when nothing is
  // visible. The parts must add up to the whole.
  assertEquals(c.total, c.on_primary + c.on_other + c.unreadable);
  assertEquals(c.on_primary, 1);
  assertEquals(c.on_other, 1);
  assertEquals((out.held as string[]).length, 2);
});

Deno.test("an unknown action is refused", async () => {
  const k = await importVaultKey(keyB64());
  const p = await project({ keys: [k] });
  const err = await assertRejects(() => handleRekey({}, p.deps));
  assert(err instanceof HttpError && err.status === 400, "expected a 400");
});
