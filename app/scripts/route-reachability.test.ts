import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `/portal/pets` was routed in `App.tsx`, specified in `docs/spec/06:63`, and
 * linked from nowhere — a 241-line screen reachable only by typing the URL.
 * Nothing noticed for the whole life of the client portal, because nothing
 * covered the client half at all (review M18).
 *
 * That is the same shape as `fn_book_walk`'s phantom `active` column: shipped,
 * specified, never exercised. The difference is that this one is checkable from
 * the route table, so it is checked.
 *
 * Deliberately a REACHABILITY check and not a coverage check. It asks whether
 * a user could ever get to a screen, which is a question about the product; it
 * does not ask whether the screen works, which is what the other suites are
 * for.
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const SRC = here("../src");

function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) {
        out.push({ file: full.slice(SRC.length + 1), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(SRC);
  return out;
}

const files = sources();
const app = files.find((f) => f.file === "App.tsx")?.text ?? "";

/** Every `<Route path="…">` the router declares, normalised to a leading slash. */
function declaredRoutes(): string[] {
  const routes: string[] = [];
  for (const [, path] of app.matchAll(/<Route\s+path="([^"]+)"/g)) routes.push(path);
  return routes;
}

/**
 * A route is reachable if some other file mentions its literal prefix — a
 * `<Link to>`, a `navigate()`, or a nav item. Parameterised segments are
 * matched by their static prefix, since `/walks/:id/live` is reached by
 * `` `/walks/${id}/live` `` and no literal will ever equal the pattern.
 */
function isReachable(path: string): boolean {
  const prefix = path.split("/:")[0];
  if (prefix === "" || prefix === "/") return true;
  return files.some(
    (f) => f.file !== "App.tsx" && !f.file.startsWith("dev/") && f.text.includes(`"${prefix}`),
  );
}

describe("every routed screen can be reached from inside the app", () => {
  it("reads a route table at all", () => {
    // A parser that finds nothing passes the rule below unconditionally.
    expect(declaredRoutes().length).toBeGreaterThan(10);
  });

  it("has no route a user could only reach by typing the URL", () => {
    // The entry points a person arrives at from outside — an email link, a
    // bookmark, a sign-out redirect — are reachable by construction and are
    // not expected to be linked from within.
    const ENTRY_POINTS = new Set(["/signin", "/onboard", "/claim/:token", "*"]);
    const unreachable = declaredRoutes()
      .filter((path) => !ENTRY_POINTS.has(path))
      .filter((path) => !path.startsWith("/dev/"))
      .filter((path) => !isReachable(path));
    expect(unreachable).toEqual([]);
  });
});

describe("there is one navigation treatment", () => {
  // `sources()` reads .ts/.tsx only, so the stylesheets are read directly here.
  // The first version of this block filtered `files` for `styles/` and asserted
  // the result was empty — which is true by construction and could never fail.
  const STYLESHEETS = ["../src/styles/components.css", "../src/styles/global.css"].map((rel) => ({
    rel,
    text: readFileSync(here(rel), "utf8"),
  }));

  it("no stylesheet forks the navigation on persona", () => {
    // The client kept a Biscuit-era bar through two brand generations because
    // 15 selectors were scoped `[data-navigation-persona="operator"]` and
    // nothing said they should not be. The attribute survives in the DOM as a
    // test and analytics hook; this is what stops it becoming a styling hook
    // again. A rule that genuinely must differ by persona should say why here
    // first — spec 05 now requires a stated reason.
    const offenders = STYLESHEETS.filter((s) => s.text.includes("data-navigation-persona"));
    expect(offenders.map((o) => o.rel)).toEqual([]);
  });

  it("the active marker is Yamabuki, not the token that claims to name it", () => {
    // CT-1 defines `--sanpo-color-navigation-active-marker` as
    // `--sanpo-color-status-current` = Kaki, and it has no consumer anywhere.
    // Spec 05:50 requires Yamabuki. So the semantically-named token and the
    // spec disagree, and anyone touching this rule who reaches for the obvious
    // name silently gets the wrong colour. A pin, not a prohibition.
    const css = STYLESHEETS[0].text;
    const marker = /\.bottom-nav \.bottom-nav__item--active::after \{[^}]*\}/.exec(css);
    expect(marker).not.toBeNull();
    expect(marker?.[0]).toContain("--sanpo-color-supporting-yamabuki");
  });
});
