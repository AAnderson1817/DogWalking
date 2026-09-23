// The types the database thinks the sender emails must be the types it emails.
//
// `fn_client_email_suppressed` (0052) tells an operator that every email to a
// client's address is off. "Every email" means every type send-notification
// actually emails — `CLIENT_FACING` — and SQL cannot import that Set, so
// `fn_client_facing_notification_types()` carries a copy. A copy is exactly
// what 0029 declined to make for the backlog, because two lists drift: add a
// client-facing type here and forget the SQL, and a client who has opted out
// of the other six is reported as reachable while the sender skips it all.
//
// So this does not restate either list. It parses the LAST definition of the
// SQL function out of the migrations (a later `create or replace` is what
// Postgres runs) and compares it with the Set the sender imports. Change either
// side alone and this fails; lose the SQL function and it fails loudly rather
// than comparing against nothing.
import { assert, assertEquals } from "./asserts.ts";
import { CLIENT_FACING } from "../send-notification/handler.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const FN = "fn_client_facing_notification_types";

async function liveBody(): Promise<string> {
  const files: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  }
  files.sort();

  let body: string | null = null;
  const re = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${FN}\\s*\\(\\s*\\)` +
      `[\\s\\S]*?\\bas\\s+\\$(\\w*)\\$([\\s\\S]*?)\\$\\1\\$`,
    "gi",
  );
  for (const name of files) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS));
    for (const m of sql.matchAll(re)) body = m[2];
  }
  assert(body !== null, `no definition of ${FN}() in any migration`);
  return body!;
}

/** The `array['a', 'b']::notification_type[]` literal out of the body. */
function typesIn(body: string): string[] {
  const m = body.match(/array\s*\[([\s\S]*?)\]\s*::\s*notification_type\s*\[\s*\]/i);
  assert(m, `${FN}() does not return an array[...]::notification_type[] literal: ${body.trim()}`);
  const types = m![1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const q = s.match(/^'([a-z_]+)'$/);
      assert(q, `${FN}() lists something that is not a plain enum label: ${s}`);
      return q![1];
    });
  assert(types.length > 0, `${FN}() lists no types`);
  return types.sort();
}

Deno.test("fn_client_facing_notification_types() is exactly the sender's CLIENT_FACING", async () => {
  assertEquals(
    typesIn(await liveBody()),
    [...CLIENT_FACING].sort(),
    "the suppressed-address notice and send-notification disagree about which types are emailed",
  );
});

Deno.test("the parser reads a body in the shape 0052 writes, and refuses one it cannot read", () => {
  // Without this, a parser that matched nothing would fail the test above for
  // the wrong reason, and one that matched loosely could pass it for one.
  assertEquals(
    typesIn(`select array['walk_complete', 'low_credit']::notification_type[];`),
    ["low_credit", "walk_complete"],
  );
  let refused = false;
  try {
    typesIn(`select enum_range(null::notification_type);`);
  } catch (e) {
    refused = e instanceof Error && /does not return an array/.test(e.message);
  }
  assert(refused, "a body that is not an array literal was read as one");
});
