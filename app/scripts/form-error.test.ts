import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  declaredObjects,
  literalText,
  resolveProperty,
  unwrapTransparent,
} from "./lib/static-object.js";
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
 * The raw live regions this gate allows, by FILE AND COMPONENT.
 *
 * It was by file alone, and a file is not a component: `components/fields.tsx`
 * also exports `Input`, `Textarea` and `Select`, so a bare
 * `<span role="alert">` added to any of them passed the gate that exists to
 * forbid it — measured, by planting one inside `Input` and again as a new
 * export, both green (Codex, PR #94). The gate BLESSING what it forbids,
 * which is the worse of the two directions.
 *
 * Named rather than pattern-matched, so the exception is editable only here
 * and only in the same commit as the thing it excuses (the `no-raw-hex.test.ts`
 * shape), and SPENT rather than merely offered: an entry matching no site is
 * itself a failure, because a stale exception excuses a real check forever.
 *
 * `StateField.tsx` is deliberately NOT listed. Its `role={role}` is an
 * expression, not the literal `"alert"`, so this scan does not see it at all —
 * and an entry that excuses nothing is an enumeration with nothing behind it,
 * which is the defect the rest of this file is about. If a future StateField
 * ever writes `role="alert"` literally onto its `<section>`, this gate will
 * say so, and that is the right outcome: the decision should be visible.
 */
const APPROVED_LIVE_REGIONS: ReadonlyArray<readonly [string, string]> = [
  ["components/fields.tsx", "FormError"],
];

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
  /** The module-scope declaration the element belongs to, or "" when none. */
  component: string;
  tag: string;
  why: string;
}

/**
 * The name the element's TOP-LEVEL STATEMENT binds — the module-scope
 * declaration it belongs to, or "" when that statement binds nothing.
 *
 * It was the NEAREST named declaration, and a nearest-name rule reads a
 * reusable name as an identity: `const helpers = { FormError: () => <span
 * role="alert" /> };` in the file that owns the approved component was
 * classified as `FormError` and inherited its exemption, so a forbidden raw
 * live region passed the gate that exists to forbid it (measured, Codex on PR
 * #94). The same held for `register({ FormError: () => … })`, for a method of
 * that name, and for a local `const FormError` nested inside another
 * component — four spellings of one hole, because a property key, a method
 * name and a local binding are all names anybody may reuse.
 *
 * So the question is which DECLARATION the element sits in, not which name is
 * closest to it. A function or class declaration answers its own name, a
 * variable statement answers the declarator on the path (`const a = 1,
 * FormError = () => …` is the second one), and every other top-level
 * statement — an expression statement, an `export default` of an anonymous
 * function — binds nothing and answers "", which is never exempt.
 *
 * That also makes the answer module-scope by construction rather than by a
 * second test: nothing nested can be the top-level statement, so a local or a
 * property named after the approved component reports the statement that
 * really does contain it.
 */
function enclosingComponent(node: ts.Node): string {
  // The outermost variable declarator on the path, which is the one the
  // top-level variable statement binds for this element.
  let declarator: ts.VariableDeclaration | undefined;
  let cur: ts.Node = node;
  while (cur.parent && !ts.isSourceFile(cur.parent)) {
    if (ts.isVariableDeclaration(cur)) declarator = cur;
    cur = cur.parent;
  }
  if (!cur.parent) return "";
  if (ts.isFunctionDeclaration(cur) || ts.isClassDeclaration(cur)) {
    return cur.name && ts.isIdentifier(cur.name) ? cur.name.text : "";
  }
  if (ts.isVariableStatement(cur)) {
    return declarator && ts.isIdentifier(declarator.name) ? declarator.name.text : "";
  }
  return "";
}

/**
 * The literal text of `name` on an object literal, or null when a member may
 * define it and this reader cannot read it, or undefined when none does.
 *
 * Spreads of object literals are resolved RECURSIVELY and in source order,
 * because one more layer of composition is still the same element:
 * `{...{ ...{ role: "alert" } }}` wrote the forbidden shape straight past the
 * version of this rule that opened only the outer spread and then looked for
 * direct property assignments (measured, 4 of 4 green). NOT depth-capped: the
 * eight it used to stop at was argued here as "not a spelling anybody reaches
 * for by accident", and it was a MISS at nine — a raw live region blessed —
 * and the only thing standing between a cyclic spread and a stack overflow.
 * A count is not a termination argument. The shared reader carries the set of
 * literals it is inside instead, so a spread that re-enters one is
 * unresolvable and depth is no rule at all (Codex, PR #94, measured).
 *
 * `undefined` vs `null` is the distinction that makes ordering work: a
 * property that is absent leaves an earlier answer standing, while one that
 * is present but dynamic replaces it with "no answer".
 *
 * The ORDER rule and every member kind live in `resolveProperty`, which
 * `verify-deployment.test.ts` reads too, so the two cannot drift about what a
 * later member does to an earlier one. What is local here is the DIRECTION:
 * a spread this reader cannot follow leaves the answer alone, because
 * refusing to un-flag is the safe direction for a question about a live
 * region — `<span role="alert" {...rest} />` must stay flagged.
 */
function objectLiteralProperty(
  obj: ts.ObjectLiteralExpression,
  name: string,
  declared: Map<string, ts.ObjectLiteralExpression> = new Map(),
): string | null | undefined {
  const value = resolveProperty(obj, name, declared, false);
  if (value === undefined) return undefined;
  return value === null ? null : literalText(value);
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
function literalAttribute(
  attributes: ts.JsxAttributes,
  name: string,
  declared: Map<string, ts.ObjectLiteralExpression> = new Map(),
): string | null {
  let value: string | null = null;
  for (const attr of attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) {
      // Only an object literal written in place can be read. Anything else —
      // `{...props}`, a call, an identifier — leaves the answer where it was,
      // which is this gate's standing rule that it does not guess.
      const spread = unwrapTransparent(attr.expression);
      // An identifier naming a uniquely-bound object literal resolves, which
      // is the ordinary attribute-composition pattern (`const errorAttrs =
      // { role: "alert" }; <span {...errorAttrs} />`) and was invisible here
      // while the channel gate's reader had followed it since round seven —
      // the same sibling asymmetry, the other way round (Codex, PR #94).
      const target = ts.isObjectLiteralExpression(spread)
        ? spread
        : ts.isIdentifier(spread)
          ? declared.get(spread.text)
          : undefined;
      if (!target) continue;
      const found = objectLiteralProperty(target, name, declared);
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
    const declared = declaredObjects(source);
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
          const role = literalAttribute(node.attributes, "role", declared);
          const cls = literalAttribute(node.attributes, "className", declared);
          const errorClass = cls !== null && /(^|\s)[a-z0-9-]*__error(\s|$)/.test(cls);
          if (role === "alert" || errorClass) {
            found.push({
              file: rel,
              line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              component: enclosingComponent(node),
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
    // The argument may carry a prelude (`const a = {…};\n<span … />`), so it
    // is parsed as a whole file and the declarations are resolved from it, the
    // way `scan()` does over a real one.
    const role = (src: string): string | null => {
      const jsx = src.includes("\n") ? src : `const e = ${src};`;
      const sf = ts.createSourceFile("f.tsx", jsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const declared = declaredObjects(sf);
      let out: string | null = null;
      const visit = (n: ts.Node): void => {
        if (ts.isJsxSelfClosingElement(n)) out = literalAttribute(n.attributes, "role", declared);
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
    // A computed key that is a string literal names exactly one property.
    expect(role('<span {...{ ["role"]: "alert" }} />')).toBe("alert");
    expect(role('<span {...{ [`role`]: "alert" }} />')).toBe("alert");
    // One the reader cannot resolve COULD be this name, so it replaces an
    // earlier answer with "no answer" rather than being passed over.
    expect(role('<span {...{ role: "alert", [k]: "x" }} />')).toBeNull();
    expect(role('<span {...{ [k]: "x" }} role="alert" />')).toBe("alert");
    // Later wins, exactly as JSX does it — in both directions.
    expect(role('<span role="status" {...{ role: "alert" }} />')).toBe("alert");
    expect(role('<span {...{ role: "alert" }} role="status" />')).toBe("status");
    // Genuinely dynamic: no answer, and no guess.
    expect(role("<span role={role} />")).toBeNull();
    expect(role("<span {...rest} />")).toBeNull();
    expect(role("<span {...{ role: computeRole() }} />")).toBeNull();
    // An unreadable spread does not ERASE evidence already found: refusing to
    // un-flag is the safe direction for a question about a live region. Both
    // positions matter — the JSX attribute list has its own rule, and the
    // second row is the one that reaches the shared reader's direction knob.
    expect(role('<span role="alert" {...rest} />')).toBe("alert");
    expect(role('<span {...{ role: "alert", ...rest }} />')).toBe("alert");
    // A shorthand naming ANOTHER key never touched this one, and it comes
    // AFTER: the row that tells "names a different key" apart from "any
    // uncertain member erases".
    expect(role('<span {...{ role: "alert", other }} />')).toBe("alert");
    expect(role("<span />")).toBeNull();
    // Transparent TypeScript wrappers: React gets the same literal.
    expect(role('<span role={"alert" as const} />')).toBe("alert");
    expect(role('<span role={("alert") as string} />')).toBe("alert");
    expect(role('<span role={"alert" satisfies string} />')).toBe("alert");
    expect(role('<span role={("alert")!} />')).toBe("alert");
    expect(role('<span {...{ role: "alert" as const }} />')).toBe("alert");
    // Depth is not a rule: nine wrappers hand the same literal through as one
    // does, and `unwrapTransparent` stopped at eight — a raw live region the
    // gate then blessed, a MISS in this file's direction (Codex, PR #94, the
    // `outward` finding's class).
    const nine = (x: string) => "(".repeat(9) + x + ")".repeat(9);
    expect(role(`<span role={${nine('"alert"')}} />`)).toBe("alert");
    expect(role(`<span {...${nine('{ role: "alert" }')}} />`)).toBe("alert");
    // A spread of a name bound to an object literal — the ordinary
    // attribute-composition pattern, and the one the channel gate's reader
    // had followed since round seven while this one had not.
    expect(role('const a = { role: "alert" };\n<span {...a} />')).toBe("alert");
    expect(role('const a = { role: "alert" as const };\n<span {...a} />')).toBe("alert");
    expect(role('const a = { role: "alert" };\n<span {...a} role="status" />')).toBe("status");
    expect(role('const a = { role: "status" };\n<span {...a} {...{ role: "alert" }} />')).toBe("alert");
    // A name bound twice is unresolvable, whichever binding carries the
    // literal — the channel gate's rule, for the reason it arrived at there.
    expect(role('const a = { role: "alert" };\nfunction f(a) { return <span {...a} />; }')).toBeNull();
    // A name that is ASSIGNED anywhere is unresolvable whatever it started
    // as: `let attrs = { role: "status" }; attrs = { role: "alert" }` is a
    // stale initializer, and a reader trusting it renders one thing and
    // reports another.
    expect(role('let a = { role: "alert" };\na = other;\n<span {...a} />')).toBeNull();
    expect(role('let a = { role: "status" };\na = { role: "alert" };\n<span {...a} />')).toBeNull();
    // …while a `let` nothing assigns to still resolves, so the rule is about
    // the assignment and not about the keyword.
    expect(role('let a = { role: "alert" };\n<span {...a} />')).toBe("alert");
    // A name that is not bound to a literal here resolves to nothing, and
    // leaves an earlier answer alone.
    expect(role('<span role="alert" {...imported} />')).toBe("alert");
    // Nested spreads: one more layer of composition is the same element.
    expect(role('<span {...{ ...{ role: "alert" } }} />')).toBe("alert");
    expect(role('<span {...{ ...{ role: "alert" }, role: "status" }} />')).toBe("status");
    expect(role('<span {...{ role: "status", ...{ role: "alert" } }} />')).toBe("alert");
    // A shorthand inside a spread is a reference, not an answer — and it
    // REPLACES an earlier one, since it could hold anything.
    expect(role('<span {...{ ...{ role: "alert" }, role }} />')).toBeNull();
    // A nested spread that mentions nothing leaves the earlier answer alone.
    expect(role('<span role="alert" {...{ ...{ className: "x" } }} />')).toBe("alert");
    // Nested NINE deep, and through an alias chain of SEVENTEEN: the shared
    // reader followed a spread to depth eight and an alias to sixteen hops,
    // and each was a miss here — one count, two walks.
    expect(role(`<span {...${"{ ...".repeat(9)}{ role: "alert" }${" }".repeat(9)}} />`)).toBe("alert");
    const chain = Array.from({ length: 17 }, (_, i) => `const a${i + 1} = a${i};`).join("\n");
    expect(role(`const a0 = { role: "alert" };\n${chain}\n<span {...a17} />`)).toBe("alert");
    // A cyclic SPREAD terminates — `var a: any = { ...a, role: "alert" }` is
    // legal and runs — and reads in source order: the later member is the
    // answer, and a cycle AFTER it does not un-flag, which is this file's
    // direction for any unfollowable spread.
    expect(role('var a: any = { ...a, role: "alert" };\n<span {...a} />')).toBe("alert");
    expect(role('var a: any = { role: "alert", ...a };\n<span {...a} />')).toBe("alert");
    // An ALIAS of a literal carries the literal — the composition pattern one
    // hop longer, which bound the alias to null and skipped the spread
    // entirely (Codex, PR #94). Transitively, and through the transparent
    // wrappers, since an alias is a value like any other.
    expect(role('const b = { role: "alert" };\nconst a = b;\n<span {...a} />')).toBe("alert");
    expect(role('const c = { role: "alert" };\nconst b = c;\nconst a = b;\n<span {...a} />')).toBe("alert");
    expect(role('const b = { role: "alert" };\nconst a = (b as never);\n<span {...a} />')).toBe("alert");
    // …and refuses when the SOURCE is not resolvable in its own right, because
    // a rebound source leaves `seen` holding a stale literal: `a` really does
    // hold the SECOND object, so answering from the first would be
    // confidently wrong rather than merely incomplete.
    expect(role('let b = { role: "status" };\nb = { role: "alert" };\nconst a = b;\n<span {...a} />')).toBeNull();
    // A mutation through either name costs both their literal, which the alias
    // graph already closed — stated here so the rule is pinned end to end.
    expect(role('const b = { role: "alert" };\nconst a = b;\nb.role = "status";\n<span {...a} />')).toBeNull();
    // A COMPUTED member of the built-in `Object` may be `assign`, so a literal
    // handed to one is no longer readable: `Object[k](b, { role: "status" })`
    // with `k: "assign"` runs exactly that, and reading `alert` off the
    // declaration was a confidently wrong answer (Codex, PR #94, round 63, in
    // the shared module). The mirror — a benign literal made `alert` by the
    // same call — stays a MISS, the dynamic-spread limit this file states.
    expect(role('const b = { role: "alert" };\nconst k: "assign" = "assign";\nObject[k](b, { role: "status" });\n<span {...b} />')).toBeNull();
    // …and the built-in reached through an alias, which the shared predicate
    // now follows (round 64): the literal is no longer readable.
    expect(role('const O = Object;\nconst b = { role: "alert" };\nO.assign(b, { role: "status" });\n<span {...b} />')).toBeNull();
    // A cycle terminates rather than resolving or hanging.
    expect(role("let b = a;\nlet a = b;\n<span {...a} />")).toBeNull();
    // An accessor or method DEFINES the property and answers a function body,
    // so it overrides an earlier spread rather than falling through it — the
    // channel reader's rule, in the file that has to agree with it.
    expect(role('const b = { role: "alert" };\n<span {...{ ...b, get role() { return "status"; } }} />'))
      .toBeNull();
    expect(role('const b = { role: "alert" };\n<span {...{ ...b, set role(v) {} }} />')).toBeNull();
    expect(role('const b = { role: "alert" };\n<span {...{ ...b, role() { return "status"; } }} />'))
      .toBeNull();
    // A computed accessor name could be this one.
    expect(role('<span {...{ role: "alert", get [k]() { return "status"; } }} />')).toBeNull();
    // An accessor on an unrelated key leaves the answer alone.
    expect(role('<span {...{ role: "alert", get other() { return 1; } }} />')).toBe("alert");
  });

  // Preconditions. An assertion that only forbids is satisfied by a scanner
  // that sees nothing, so the scan is proven live before it is believed.
  it("reads the .tsx files under app/src", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds the raw live region in the component that owns it", () => {
    // The file, the COMPONENT and the shape, never the line: a precondition
    // pinned to a line number goes red the first time somebody edits a comment
    // above it, which is a gate red on a healthy tree. The line is in the
    // failure message, which is where a reader wants it.
    expect(
      sites.map((s) => `${s.file} ${s.component} <${s.tag}> ${s.why}`),
      "the parser found no raw live region at all — it is not reading tags or attributes",
    ).toContain('components/fields.tsx FormError <span> role="alert"');
  });

  it("has no bare error element outside the approved components", () => {
    const approved = new Set(APPROVED_LIVE_REGIONS.map(([f, c]) => `${f} ${c}`));
    const offenders = sites.filter((s) => !approved.has(`${s.file} ${s.component}`));
    expect(
      offenders.map((s) => `${s.file}:${s.line} ${s.component || "<module scope>"} <${s.tag}> ${s.why}`),
      'a raw element carries an error live region — render it through <FormError /> or <StateField role="alert" />',
    ).toEqual([]);
  });

  it("spends every approved exemption", () => {
    // A stale exception excuses a real check forever, so an entry matching no
    // site fails here rather than sitting unnoticed — the same rule
    // `verify-deployment.sh`'s `contract_for` carries.
    const unspent = APPROVED_LIVE_REGIONS.filter(
      ([file, component]) => !sites.some((s) => s.file === file && s.component === component),
    );
    expect(
      unspent.map(([f, c]) => `${f} ${c}`),
      "an approved live region no longer exists — remove the entry or restore the component",
    ).toEqual([]);
  });

  it("reads the enclosing component in every declaration spelling", () => {
    // Pinned on fixtures as well as on the tree, because the tree holds one
    // site and a reader that answered "" to everything would pass the
    // exemption check for the wrong reason — and would then exempt nothing,
    // which is a gate red on a healthy tree the day somebody writes the
    // component with an arrow instead of `function`.
    const at = (src: string): string => {
      const sf = ts.createSourceFile("f.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let out = "<none>";
      const visit = (n: ts.Node): void => {
        if (ts.isJsxSelfClosingElement(n)) out = enclosingComponent(n);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return out;
    };

    expect(at('function FormError() { return <span role="alert" />; }')).toBe("FormError");
    expect(at('export function FormError() { return <span role="alert" />; }')).toBe("FormError");
    expect(at('const FormError = () => <span role="alert" />;')).toBe("FormError");
    expect(at('const FormError = function () { return <span role="alert" />; };')).toBe("FormError");
    // The declarator ON THE PATH, not the first one the statement declares.
    expect(at('const a = 1, FormError = () => <span role="alert" />;')).toBe("FormError");
    // A nested anonymous callback belongs to the declaration above it.
    expect(at('function FormError() { return xs.map(() => <span role="alert" />); }')).toBe("FormError");

    // A REUSABLE NAME is not a declaration. Each of these was classified as
    // the approved `FormError` by the nearest-name rule and inherited its
    // exemption (Codex, PR #94); each now answers the statement that really
    // contains it, and none of those is exempt.
    expect(at('const helpers = { FormError: () => <span role="alert" /> };')).toBe("helpers");
    expect(at('register({ FormError: () => <span role="alert" /> });')).toBe("");
    expect(at('class Fields { FormError() { return <span role="alert" />; } }')).toBe("Fields");
    expect(at('function Input() { const FormError = () => <span role="alert" />; return FormError; }'))
      .toBe("Input");
    expect(at('register({ m() { const FormError = () => <span role="alert" />; return FormError; } });'))
      .toBe("");
    // A method name is a property name too, so the class answers, not the method.
    expect(at('class C { render() { return <span role="alert" />; } }')).toBe("C");

    // A top-level statement that binds nothing: never exempt, which is the
    // refusing direction.
    expect(at('export default () => <span role="alert" />;')).toBe("");
    expect(at('render(<span role="alert" />);')).toBe("");
    // …and one that binds an ordinary name answers it, which is also not exempt.
    expect(at('const e = <span role="alert" />;')).toBe("e");
  });
});
