import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every error the product shows goes through one of two components, and this
 * is what checks it.
 *
 * `FormError` (components/fields.tsx) is the form-error region: always
 * mounted, so the live region exists before its text arrives — `role="alert"`
 * on an element that appears together with its message is announced far less
 * reliably (a11y(vault+errors), review H25). `StateField` is the panel-sized
 * version for a screen that cannot load, and takes `role="alert"` as a prop.
 * Neither is the only way to write an error, which is why this is checked
 * rather than remembered.
 *
 * It replaces a CI grep for the literal `className="field__error"`, which
 * passed for everything else: a bare `<span className="signin__error"
 * role="alert">` — the exact element FormError exists to replace — was
 * invisible to it, and so was any role it could not see on the same line
 * (spec-drift audit). A grep also cannot tell `<StateField role="alert">`
 * from `<span role="alert">` when the attribute sits four lines below the
 * tag, which is how every legitimate use in this tree is formatted. So this
 * reads the JSX.
 *
 * The rules, and the one shape each exists for:
 *   - A `role` that can be `"alert"` belongs on a `StateField` and nowhere
 *     else. A `role` whose value the scan cannot read (`role={r}`) is refused
 *     too, because a passthrough is exactly how an alert region gets
 *     smuggled past a check that reads literals.
 *   - `aria-live="assertive"` is the same region without the role, so it gets
 *     the same rule.
 *   - An `__error` class token is FormError's, in any string in the tree: a
 *     literal assembled in a variable (`const cls = "signin__error"`) is
 *     caught where it is written, not only where it is applied. The one
 *     exception is `FormError`'s own `className` prop, which layers a layout
 *     class onto the region (`claim-invite__error`) rather than building one.
 *   - Object literals are read as well as JSX (`{ role: "alert" }`), since
 *     `<span {...props}>` and `createElement` carry props that way.
 *
 * `fields.tsx` and `StateField.tsx` are the implementations, so they are the
 * only files exempt. Test files are fixtures and are not read.
 */

const SRC = join(import.meta.dirname, "..", "src");
const IMPLEMENTATIONS = new Set(["components/fields.tsx", "components/StateField.tsx"]);

interface Finding {
  file: string;
  line: number;
  rule: "role" | "aria-live" | "error-class";
  text: string;
}

const UNREADABLE = Symbol("unreadable");
type Value = string | null | typeof UNREADABLE;

/**
 * The values an attribute expression can produce, read from the expressions
 * that produce it: both arms of a ternary, the right of `&&`, either side of
 * `||`/`??`, through parentheses and type assertions. `null`, `undefined` and
 * booleans set no role and read as `null`. Anything else — an identifier, a
 * call, a template with a hole — could be any string, and is UNREADABLE.
 */
function valuesOf(node: ts.Node): Value[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return valuesOf(node.expression);
  if (ts.isConditionalExpression(node)) return [...valuesOf(node.whenTrue), ...valuesOf(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return [null, ...valuesOf(node.right)];
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return [...valuesOf(node.left), ...valuesOf(node.right)];
    }
  }
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword) return [null];
  if (ts.isIdentifier(node) && node.text === "undefined") return [null];
  return [UNREADABLE];
}

/** The value of a JSX attribute, or of an object-literal property. */
function valueOf(init: ts.Node | undefined): ts.Node | undefined {
  if (!init) return undefined;
  if (ts.isJsxExpression(init)) return init.expression;
  return init;
}

/**
 * `word` can come out of this value. On a JSX attribute an UNREADABLE value
 * counts too: `role` there is always the ARIA attribute, so `role={r}` is a
 * passthrough the scan refuses rather than assumes harmless. On an object
 * literal it does not — `role` is an ordinary property name (the signed-in
 * persona is `role: null` in auth-context), so only a literal `"alert"` there
 * is evidence of anything.
 */
function mayBe(value: ts.Node | undefined, word: string, unreadableCounts: boolean): boolean {
  if (!value) return false;
  return valuesOf(value).some((v) =>
    v === UNREADABLE ? unreadableCounts : typeof v === "string" && v.trim().toLowerCase() === word);
}

const ERROR_CLASS = /__error(?:--[A-Za-z0-9-]+)?$/;
const hasErrorClass = (s: string) => s.split(/\s+/).some((token) => ERROR_CLASS.test(token));

function tagName(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  return el.tagName.getText();
}

function propName(name: ts.PropertyName | ts.JsxAttributeName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return undefined;
  return undefined;
}

/**
 * Findings for one file, and how many alert roles the visitor inspected on the
 * way — allowed ones included — so the tree test can tell "nothing wrong" from
 * "read nothing".
 */
function scan(file: string, text: string): { findings: Finding[]; alertRoles: number } {
  if (IMPLEMENTATIONS.has(file)) return { findings: [], alertRoles: 0 };
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];
  let alertRoles = 0;
  const at = (node: ts.Node, rule: Finding["rule"]) =>
    findings.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      rule,
      text: node.getText(sf).replace(/\s+/g, " ").slice(0, 100),
    });

  // String literals that are FormError's own `className` — the one place an
  // `__error` class may be written outside fields.tsx.
  const formErrorClass = new Set<ts.Node>();

  const visitProps = (
    owner: string | null,
    name: string | undefined,
    value: ts.Node | undefined,
    site: ts.Node,
  ) => {
    const jsx = owner !== null;
    if (name === "role" && mayBe(value, "alert", jsx)) {
      alertRoles += 1;
      if (owner !== "StateField") at(site, "role");
    }
    if (name === "aria-live" && mayBe(value, "assertive", jsx)) at(site, "aria-live");
    if (name === "className" && owner === "FormError" && value) {
      const mark = (n: ts.Node) => {
        formErrorClass.add(n);
        ts.forEachChild(n, mark);
      };
      mark(value);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const owner = tagName(node);
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr)) visitProps(owner, propName(attr.name), valueOf(attr.initializer), attr);
      }
    } else if (ts.isPropertyAssignment(node)) {
      visitProps(null, propName(node.name), node.initializer, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const strings = (node: ts.Node) => {
    const isString = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (isString && !formErrorClass.has(node) && hasErrorClass((node as ts.LiteralLikeNode).text)) {
      at(node, "error-class");
    }
    ts.forEachChild(node, strings);
  };
  strings(sf);
  return { findings, alertRoles };
}

const scanSource = (file: string, text: string): Finding[] => scan(file, text).findings;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function scanTree(): { files: number; findings: Finding[]; alertSites: number } {
  const files = sources(SRC);
  const findings: Finding[] = [];
  let alertSites = 0;
  for (const path of files) {
    const file = relative(SRC, path).split("\\").join("/");
    const result = scan(file, readFileSync(path, "utf8"));
    // Counted by the same visitor that judges them, so a scanner that reads no
    // attribute at all cannot report a clean tree: every legitimate
    // `role="alert"` is a StateField prop, and there are several.
    alertSites += result.alertRoles;
    findings.push(...result.findings);
  }
  return { files: files.length, findings, alertSites };
}

const show = (fs: Finding[]) =>
  fs.map((f) => `  ${f.file}:${f.line} [${f.rule}] ${f.text}`).join("\n");

describe("every error goes through FormError or StateField", () => {
  it("holds for the tree", () => {
    const { files, findings, alertSites } = scanTree();
    // Preconditions: a scan that reads nothing reports agreement.
    expect(files, "the scan found no source files").toBeGreaterThan(50);
    expect(alertSites, "the visitor inspected no alert role — it is not reading attributes").toBeGreaterThan(3);
    expect(
      findings,
      `an error region outside FormError / StateField — render it with <FormError message={…} /> `
        + `(a form error) or <StateField role="alert" … /> (a screen that cannot load):\n${show(findings)}`,
    ).toEqual([]);
  });
});

describe("what the scan refuses and admits", () => {
  const rules = (text: string, file = "screens/Probe.tsx") => scanSource(file, text).map((f) => f.rule);

  it("refuses the bare span FormError exists to replace", () => {
    // The shape the old grep passed: neither `field__error` nor on one line.
    expect(rules(`export const X = ({ e }) => (
      <span
        className="signin__error"
        role="alert"
      >{e}</span>);`)).toEqual(["role", "error-class"]);
  });

  it("refuses a role that can be alert on any element but StateField", () => {
    expect(rules(`<p role="alert">x</p>`)).toEqual(["role"]);
    expect(rules(`<div role={"alert"}>x</div>`)).toEqual(["role"]);
    expect(rules(`<div role={bad ? "alert" : "status"}>x</div>`)).toEqual(["role"]);
    // A component forwards it to a DOM node just the same.
    expect(rules(`<Card role="alert">x</Card>`)).toEqual(["role"]);
    expect(rules(`<my-widget role="alert" />`)).toEqual(["role"]);
  });

  it("refuses a role it cannot read, rather than assuming it is harmless", () => {
    expect(rules(`<span role={r}>x</span>`)).toEqual(["role"]);
  });

  it("admits roles that are not alert, and StateField's own prop", () => {
    expect(rules(`<span role="status">x</span>`)).toEqual([]);
    expect(rules(`<span role={undefined}>x</span>`)).toEqual([]);
    expect(rules(`<span role={open && "dialog"}>x</span>`)).toEqual([]);
    expect(rules(`<div role={t ? "timer" : undefined}>x</div>`)).toEqual([]);
    expect(rules(`<StateField role="alert" title="x" />`)).toEqual([]);
    expect(rules(`<StateField\n  title="x"\n  detail={d}\n  role="alert"\n/>`)).toEqual([]);
  });

  it("refuses an assertive live region, which is the same region without the role", () => {
    expect(rules(`<span aria-live="assertive">x</span>`)).toEqual(["aria-live"]);
    expect(rules(`<span aria-live="polite">x</span>`)).toEqual([]);
  });

  it("refuses an __error class wherever the string is written", () => {
    expect(rules(`<p className="x__error">x</p>`)).toEqual(["error-class"]);
    expect(rules("<p className={`card ${a}__error`}>x</p>")).toEqual(["error-class"]);
    expect(rules(`const cls = "signin__error";`)).toEqual(["error-class"]);
    expect(rules(`<p className="x__error--big">x</p>`)).toEqual(["error-class"]);
    // A class that merely contains the word is somebody else's.
    expect(rules(`<p className="walk-card__error-count">x</p>`)).toEqual([]);
  });

  it("admits a layout class on FormError itself", () => {
    expect(rules(`<FormError message={e} className="claim-invite__error" />`)).toEqual([]);
  });

  it("reads object literals, which is how spread props and createElement carry a role", () => {
    expect(rules(`const props = { role: "alert" };`)).toEqual(["role"]);
    expect(rules(`createElement("span", { "aria-live": "assertive" });`)).toEqual(["aria-live"]);
    // An icon called "alert" is not a role, and neither is a signed-in
    // persona: `role` is an ordinary property name outside JSX, so only a
    // literal "alert" there is evidence of anything.
    expect(rules(`const MARKS = { failed: "alert" };`)).toEqual([]);
    expect(rules(`setState({ session, role: null, roleError: null });`)).toEqual([]);
    expect(rules(`const next = { role: resolved.role };`)).toEqual([]);
  });

  it("does not read comments or JSX text", () => {
    expect(rules(`// <span role="alert" className="x__error">\nexport const a = 1;`)).toEqual([]);
    expect(rules(`<p>role="alert" x__error</p>`)).toEqual([]);
  });

  it("exempts the two implementations and nothing else", () => {
    const bare = `<span role="alert" className="field__error" />`;
    expect(rules(bare, "components/fields.tsx")).toEqual([]);
    expect(rules(bare, "components/StateField.tsx")).toEqual([]);
    expect(rules(bare, "components/fieldsx.tsx")).toEqual(["role", "error-class"]);
  });
});
