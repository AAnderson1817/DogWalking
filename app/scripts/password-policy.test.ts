import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The client-side password rule is a second copy of a server rule. This is the
 * test that stops it becoming a *different* rule.
 *
 * It lives in `scripts/` with the other text-analysis checks because it reads
 * a file off disk, and `src` is typed by `tsconfig.app.json`, which has no Node
 * types.
 */
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * Read by TEXT rather than by import: `scripts/` is typed by
 * `tsconfig.node.json`, whose node16 resolution cannot import a `src/` module
 * without a `.js` specifier, and threading that through to buy a comparison
 * of two literals is not worth the plumbing. Both sides are literals in both
 * files, so a text read compares exactly what a reader of either file sees.
 */
const POLICY = read("../src/lib/password-policy.ts");
const TOML = readFileSync(
  fileURLToPath(new URL("../../supabase/config.toml", import.meta.url)),
  "utf8",
);

/**
 * Read one key out of the `[auth]` table specifically. A bare search for
 * `minimum_password_length` would also match a commented-out example or the
 * same key under another table; anchoring on the section means the test is
 * reading what GoTrue reads.
 */
function authValue(key: string): string {
  const section = TOML.slice(TOML.indexOf("\n[auth]\n"));
  const end = section.indexOf("\n[", 1);
  const body = end === -1 ? section : section.slice(0, end);
  const m = new RegExp(`(?<!#[^\\n]*)^${key}\\s*=\\s*(.+)$`, "m").exec(body);
  expect(m, `${key} is not set in the [auth] table of supabase/config.toml`).not.toBeNull();
  return m![1].trim().replace(/^"|"$/g, "");
}

/** The value of an exported `const` in `password-policy.ts`. */
function policyConst(name: string): string {
  const m = new RegExp(`export const ${name} = (.+);`).exec(POLICY);
  expect(m, `${name} is not exported from src/lib/password-policy.ts`).not.toBeNull();
  return m![1].trim().replace(/^"|"$/g, "");
}

describe("the client password rule matches the server's", () => {
  it("agrees with supabase/config.toml", () => {
    expect(policyConst("PASSWORD_MIN_LENGTH")).toBe(authValue("minimum_password_length"));
    expect(policyConst("PASSWORD_REQUIREMENTS")).toBe(authValue("password_requirements"));
  });

  /**
   * The check above compares two strings and would pass vacuously if both
   * parsers returned nothing. This asserts each read a real value.
   */
  it("actually parsed both files", () => {
    expect(Number(policyConst("PASSWORD_MIN_LENGTH"))).toBeGreaterThanOrEqual(12);
    expect(TOML).toContain("[auth]");
  });
});
