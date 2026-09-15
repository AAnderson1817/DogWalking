import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every form error in the product renders through `FormError`, and every other
 * error state through `StateField`. Both mount their live region before its
 * text arrives, which is the whole reason they exist: `role="alert"` on an
 * element that appears TOGETHER with its message is announced far less
 * reliably (a11y(vault+errors), review M12/M13).
 *
 * This replaces a `ci.yml` grep for the literal `className="field__error"`
 * outside `fields.tsx`. That grep had two defects, and the spec-drift audit
 * found the first:
 *
 *  - It matched ONE literal class name, so a bare
 *    `<span className="onboard__error" role="alert">` — exactly the shape the
 *    rule exists to forbid — slipped past under any other name. Measured, by
 *    planting that span and watching the shipped grep report PASS.
 *
 *  - The remedy the audit proposed, failing any `__error` class outside
 *    `fields.tsx`, would have gone RED ON A HEALTHY TREE, which this
 *    repository's log calls the worst shape available:
 *    `<FormError message={error} className="claim-invite__error" />` is
 *    CORRECT usage, and so is every `role="alert"` in `app/src` outside
 *    `fields.tsx` — all NINE are props handed to `StateField`, never
 *    attributes on a raw element (counted: LoadError, ErrorBoundary,
 *    NotificationInbox, SignIn, Onboard, WalkMode, ResetPassword, Signup,
 *    ClaimInvite).
 *
 * So the rule is about the TAG, which a grep cannot see and a parser can: a
 * lowercase JSX tag is a raw DOM element, a capitalised one is a component
 * that owns its own live region. Handing `role` or a class to a component is
 * how the approved path is used; writing either onto a `<span>` or a `<div>`
 * is the defect.
 */

const APP_SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * The one file that legitimately puts a live region on a raw element, because
 * it IS the approved component. Named rather than pattern-matched, so the
 * exception is editable only here and only in the same commit as the thing it
 * excuses (the `no-raw-hex.test.ts` shape).
 *
 * `StateField.tsx` is deliberately NOT listed. Its `role={role}` is an
 * expression, not the literal `"alert"`, so this scan does not see it at all —
 * and an entry that excuses nothing is an enumeration with nothing behind it,
 * which is the defect the rest of this file is about. If a future StateField
 * ever writes `role="alert"` literally onto its `<section>`, this gate will
 * say so, and that is the right outcome: the decision should be visible.
 */
const OWNS_A_LIVE_REGION = "components/fields.tsx";

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

interface Site {
  file: string;
  line: number;
  tag: string;
  why: string;
}

/**
 * The text of a statically readable string, or null for a dynamic one.
 *
 * `as const`, `as string`, `satisfies`, parentheses and `!` are TRANSPARENT:
 * React receives the same literal through every one of them, and a reader that
 * stops at the wrapper calls the attribute dynamic and looks away. Measured:
 * `<span role={"alert" as const} />` passed 4 of 4 (Codex, PR #94).
 */
function literalText(e: ts.Expression): string | null {
  let cur = e;
  for (let i = 0; i < 8; i += 1) {
    if (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur)) return cur.text;
    if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)
      || ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)
      || ts.isTypeAssertionExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * `name`'s value in an object literal, spreads of object literals resolved
 * RECURSIVELY and in source order — or `undefined` when the literal does not
 * mention it at all, which is different from mentioning it dynamically.
 *
 * Recursive because one more layer of composition is still the same element:
 * `{...{ ...{ role: "alert" } }}` wrote the forbidden shape straight past the
 * version of this rule that opened only the outer spread and then looked for
 * direct property assignments (measured, 4 of 4 green). Depth-capped, since a
 * literal nested eight deep is not a spelling anybody reaches for by accident
 * and this gate catches the mistake rather than the adversary.
 *
 * `undefined` vs `null` is the distinction that makes ordering work: a
 * property that is absent leaves an earlier answer standing, while one that
 * is present but dynamic replaces it with "no answer".
 */
function objectLiteralProperty(
  obj: ts.ObjectLiteralExpression,
  name: string,
  depth = 0,
): string | null | undefined {
  let value: string | null | undefined;
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (!ts.isObjectLiteralExpression(prop.expression) || depth >= 8) continue;
      const nested = objectLiteralProperty(prop.expression, name, depth + 1);
      if (nested !== undefined) value = nested;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      // `{ role }` carries a reference this gate cannot resolve.
      if (prop.name.text === name) value = null;
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (key === name) value = literalText(prop.initializer);
  }
  return value;
}

/**
 * The text of a string-valued JSX attribute, or null when it is an expression.
 *
 * Reads three spellings, and each was added after the previous one let the
 * forbidden shape through:
 *
 *   role="alert"                 the plain attribute
 *   role={"alert"}               the same attribute with braces round it
 *   {...{ role: "alert" }}       an object spread of a literal
 *
 * All three are the same element to React and to a screen reader, and the
 * last two each measured green against the version of this gate before them —
 * `<span className={"signin__error"} role={"alert"}>` passed the first, and
 * `<span {...{ className: "signin__error", role: "alert" }}>` passed the
 * second. LATER WINS, exactly as JSX does it, so a spread after an attribute
 * overrides it and an attribute after a spread overrides the spread.
 *
 * `className={cx(...)}`, `role={role}` and `{...props}` are genuinely dynamic:
 * not this gate's business, because the compiler cannot say what they hold and
 * a guess in either direction is worse than the silence.
 */
function literalAttribute(attributes: ts.JsxAttributes, name: string): string | null {
  let value: string | null = null;
  for (const attr of attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) {
      // Only an object literal written in place can be read. Anything else —
      // `{...props}`, a call, an identifier — leaves the answer where it was,
      // which is this gate's standing rule that it does not guess.
      const spread = attr.expression;
      if (!ts.isObjectLiteralExpression(spread)) continue;
      const found = objectLiteralProperty(spread, name);
      if (found !== undefined) value = found;
      continue;
    }
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== name) continue;
    const init = attr.initializer;
    if (!init) { value = null; continue; }
    if (ts.isStringLiteral(init)) { value = init.text; continue; }
    if (ts.isJsxExpression(init) && init.expression) { value = literalText(init.expression); continue; }
    value = null;
  }
  return value;
}

function scan(files: string[]): Site[] {
  const found: Site[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rel = relative(APP_SRC, file).split("\\").join("/");

    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const name = node.tagName;
        const tag = name.getText();
        // JSX resolves a tag three ways, and only two of them are raw DOM
        // elements. A lowercase IDENTIFIER (`span`) is intrinsic, and so is a
        // namespaced name (`svg:circle`). A property access is NOT, whatever
        // its case — `<ui.FormError role="alert" />` after
        // `import * as ui from "./fields"` is the approved component reached
        // through a namespace import, and the first version of this rule asked
        // `/^[a-z]/` of the whole tag text and called it a raw element:
        // measured, a gate red on healthy code, which is the shape the rest of
        // this file is about.
        const intrinsic =
          (ts.isIdentifier(name) && /^[a-z]/.test(tag)) || ts.isJsxNamespacedName(name);
        if (intrinsic) {
          const role = literalAttribute(node.attributes, "role");
          const cls = literalAttribute(node.attributes, "className");
          const errorClass = cls !== null && /(^|\s)[a-z0-9-]*__error(\s|$)/.test(cls);
          if (role === "alert" || errorClass) {
            found.push({
              file: rel,
              line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              tag,
              why: role === "alert" ? 'role="alert"' : `className "${cls}"`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("every error message renders through FormError or StateField", () => {
  const files = tsxFiles(APP_SRC);
  const sites = scan(files);

  // The attribute reader, pinned on fixtures rather than only on the tree.
  // Every spelling below was added after the previous version of this rule let
  // the forbidden shape through, and each is the same element to React and to
  // a screen reader. Both directions matter: a reader that answered "alert" to
  // everything would pass every sabotage of these rules for the wrong reason.
  it("reads a JSX attribute in every static spelling, and guesses at none", () => {
    const role = (jsx: string): string | null => {
      const sf = ts.createSourceFile("f.tsx", `const e = ${jsx};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let out: string | null = null;
      const visit = (n: ts.Node): void => {
        if (ts.isJsxSelfClosingElement(n)) out = literalAttribute(n.attributes, "role");
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return out;
    };

    expect(role('<span role="alert" />')).toBe("alert");
    expect(role('<span role={"alert"} />')).toBe("alert");
    expect(role("<span role={`alert`} />")).toBe("alert");
    expect(role('<span {...{ role: "alert" }} />')).toBe("alert");
    expect(role('<span {...{ "role": "alert" }} />')).toBe("alert");
    // Later wins, exactly as JSX does it — in both directions.
    expect(role('<span role="status" {...{ role: "alert" }} />')).toBe("alert");
    expect(role('<span {...{ role: "alert" }} role="status" />')).toBe("status");
    // Genuinely dynamic: no answer, and no guess.
    expect(role("<span role={role} />")).toBeNull();
    expect(role("<span {...rest} />")).toBeNull();
    expect(role("<span {...{ role: computeRole() }} />")).toBeNull();
    // An unreadable spread does not ERASE evidence already found: refusing to
    // un-flag is the safe direction for a question about a live region.
    expect(role('<span role="alert" {...rest} />')).toBe("alert");
    expect(role("<span />")).toBeNull();
    // Transparent TypeScript wrappers: React gets the same literal.
    expect(role('<span role={"alert" as const} />')).toBe("alert");
    expect(role('<span role={("alert") as string} />')).toBe("alert");
    expect(role('<span role={"alert" satisfies string} />')).toBe("alert");
    expect(role('<span role={("alert")!} />')).toBe("alert");
    expect(role('<span {...{ role: "alert" as const }} />')).toBe("alert");
    // Nested spreads: one more layer of composition is the same element.
    expect(role('<span {...{ ...{ role: "alert" } }} />')).toBe("alert");
    expect(role('<span {...{ ...{ role: "alert" }, role: "status" }} />')).toBe("status");
    expect(role('<span {...{ role: "status", ...{ role: "alert" } }} />')).toBe("alert");
    // A shorthand inside a spread is a reference, not an answer — and it
    // REPLACES an earlier one, since it could hold anything.
    expect(role('<span {...{ ...{ role: "alert" }, role }} />')).toBeNull();
    // A nested spread that mentions nothing leaves the earlier answer alone.
    expect(role('<span role="alert" {...{ ...{ className: "x" } }} />')).toBe("alert");
  });

  // Preconditions. An assertion that only forbids is satisfied by a scanner
  // that sees nothing, so the scan is proven live before it is believed.
  it("reads the .tsx files under app/src", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds the raw live region in the file that owns it", () => {
    // The file and the shape, never the line: a precondition pinned to a line
    // number goes red the first time somebody edits a comment above it, which
    // is a gate red on a healthy tree. The line is in the failure message,
    // which is where a reader wants it.
    expect(
      sites.map((s) => `${s.file} <${s.tag}> ${s.why}`),
      "the parser found no raw live region at all — it is not reading tags or attributes",
    ).toContain('components/fields.tsx <span> role="alert"');
  });

  it("has no bare error element outside that file", () => {
    const offenders = sites.filter((s) => s.file !== OWNS_A_LIVE_REGION);
    expect(
      offenders.map((s) => `${s.file}:${s.line} <${s.tag}> ${s.why}`),
      'a raw element carries an error live region — render it through <FormError /> or <StateField role="alert" />',
    ).toEqual([]);
  });
});
