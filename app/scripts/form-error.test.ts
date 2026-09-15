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

/** The text of a string-valued JSX attribute, or null when it is an expression. */
function literalAttribute(attributes: ts.JsxAttributes, name: string): string | null {
  for (const attr of attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== name) continue;
    const init = attr.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
    // `className={cx(...)}` and `role={role}` are expressions: not a literal,
    // and not this gate's business — the compiler cannot say what they hold,
    // and a guess in either direction is worse than the silence.
    return null;
  }
  return null;
}

function scan(files: string[]): Site[] {
  const found: Site[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rel = relative(APP_SRC, file).split("\\").join("/");

    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText();
        // A lowercase tag is an intrinsic DOM element; a capitalised one is a
        // component, and `role`/`className` on it are props it decides about.
        if (/^[a-z]/.test(tag)) {
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

  // Preconditions. An assertion that only forbids is satisfied by a scanner
  // that sees nothing, so the scan is proven live before it is believed.
  it("reads the .tsx files under app/src", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds the raw live region in the file that owns it", () => {
    expect(
      sites.map((s) => `${s.file}:${s.line} <${s.tag}> ${s.why}`),
      "the parser found no raw live region at all — it is not reading tags or attributes",
    ).toContain('components/fields.tsx:37 <span> role="alert"');
  });

  it("has no bare error element outside that file", () => {
    const offenders = sites.filter((s) => s.file !== OWNS_A_LIVE_REGION);
    expect(
      offenders.map((s) => `${s.file}:${s.line} <${s.tag}> ${s.why}`),
      'a raw element carries an error live region — render it through <FormError /> or <StateField role="alert" />',
    ).toEqual([]);
  });
});
