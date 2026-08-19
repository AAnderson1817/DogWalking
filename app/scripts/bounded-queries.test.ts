import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every list query is bounded (review M9).
 *
 * `api.ts` is a direct PostgREST client and had 61 exported functions with two
 * `.limit()` calls between them. PostgREST caps an unbounded select at
 * `max_rows` — 1000, set in `config.toml` and the platform default — and
 * returns the first page WITHOUT SAYING SO. So this is not only waste:
 *
 *   - `listPayments()` feeds Today's "Needs attention" strip and Money's three
 *     headline totals. Past the cap they silently under-report, on the screen
 *     an operator uses to decide whether they have been paid.
 *   - `listWalksDetailed({})` in PortalHome orders ASCENDING, so a client past
 *     the cap keeps their oldest walks and loses every recent one — including
 *     the "next walk" card the screen exists for.
 *
 * A limit does not remove the cap; it makes the boundary explicit and chosen,
 * so a caller can say what it is. That is the rule this asserts.
 *
 * Bounds are declared here rather than merely detected, because the right
 * number is a judgement per query — `listWalkGpsPoints` bounded at 200 would
 * silently truncate a route, which is the defect wearing the fix's clothes.
 */

const API = join(import.meta.dirname, "..", "src", "lib", "api.ts");

/**
 * Queries deliberately without a row limit, each with the reason.
 *
 * By name, so an exemption is a decision recorded next to the rule rather than
 * something that happens by omission.
 */
const UNBOUNDED_ALLOWED: Record<string, string> = {
  listSchedulePets:
    "pets on one schedule; bounded by the pets a single client owns, and a "
    + "truncated list would silently drop a pet from a recurring walk.",
};

/**
 * Helpers that apply the bound on a caller's behalf.
 *
 * `walkQuery` shares the filter/order/limit chain between `listWalks` and
 * `listWalksDetailed` so the two cannot drift apart — which means the textual
 * check below has to follow it. Named explicitly, and each one is separately
 * asserted to actually apply a limit, so the indirection cannot become a hole.
 */
const BOUNDED_HELPERS = ["walkQuery"];

/** Extracts each exported function body from `api.ts`. */
function functionBodies(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:export\s+)?(?:async\s+)?function\s+(\w+)[\s\S]*?(?=\nexport\s|\nfunction\s|\n\/\*\*|$)/g;
  for (const m of source.matchAll(re)) out.set(m[1]!, m[0]!);
  return out;
}

/** Bounded directly, or by delegating to a helper that bounds. */
function isBounded(body: string): boolean {
  if (/\.limit\(|\.range\(/.test(body)) return true;
  return BOUNDED_HELPERS.some((h) => new RegExp(`\\b${h}\\(`).test(body));
}

/** A query that returns many rows: `.select(` without a single-row terminator. */
function isListQuery(body: string): boolean {
  if (!/\.from\(/.test(body)) return false;
  if (/\.single\(\)|\.maybeSingle\(\)/.test(body)) return false;
  // Mutations return what they wrote; the bound is the write itself.
  if (/\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(body)) return false;
  return /\.select\(/.test(body);
}

describe("every list query is bounded", () => {
  const source = readFileSync(API, "utf8");
  const bodies = functionBodies(source);

  it("finds the api module and its functions", () => {
    // Vacuity guard: a regex that matches nothing passes everything below.
    expect(bodies.size).toBeGreaterThan(40);
    expect(bodies.has("listPayments")).toBe(true);
    expect(bodies.has("listWalksDetailed")).toBe(true);
  });

  it("recognises list queries at all", () => {
    const lists = [...bodies].filter(([, b]) => isListQuery(b));
    expect(lists.length).toBeGreaterThan(10);
  });

  it("carries a row limit on every one", () => {
    const unbounded = [...bodies]
      .filter(([, body]) => isListQuery(body) && !isBounded(body))
      .map(([name]) => name)
      .filter((name) => !(name in UNBOUNDED_ALLOWED));
    expect(
      unbounded,
      "PostgREST truncates at max_rows and does not say so. Add a .limit() with "
        + "a number the caller can state, or an entry in UNBOUNDED_ALLOWED with a reason.",
    ).toEqual([]);
  });

  it("every bounding helper actually bounds", () => {
    // Without this the helper indirection is a hole: any function calling
    // `walkQuery` would read as bounded whether or not `walkQuery` still is.
    for (const helper of BOUNDED_HELPERS) {
      const body = bodies.get(helper);
      expect(body, `${helper} is listed as a bounding helper but does not exist`).toBeTruthy();
      expect(
        /\.limit\(|\.range\(/.test(body!),
        `${helper} is listed as a bounding helper but applies no limit`,
      ).toBe(true);
    }
  });

  it("keeps the exemption list honest", () => {
    // In the other direction: an exemption for a query that no longer exists,
    // or that has since been bounded, makes the list stop meaning what it says.
    for (const name of Object.keys(UNBOUNDED_ALLOWED)) {
      const body = bodies.get(name);
      expect(body, `${name} is exempted but does not exist`).toBeTruthy();
      expect(
        /\.limit\(|\.range\(/.test(body!),
        `${name} is exempted but is bounded — drop the exemption`,
      ).toBe(false);
    }
  });
});
