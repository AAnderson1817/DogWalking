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
 *     `<span {...props}>` and `createElement` carry props that way — and so is
 *     the spread itself. A spread whose object the scan can see (a literal,
 *     or a `const` bound to one, either arm of a ternary) is read as though
 *     each of its properties were written on the element, so `{ role: r }`
 *     spread onto a `<span>` is refused exactly as `<span role={r}>` is.
 *     `createElement`'s props (and `cloneElement`'s, and the automatic
 *     runtime's `jsx`) are applied exactly as a spread is, and judged so.
 *   - A spread the scan cannot see is refused as both attributes it could
 *     carry, with one exception: `{...rest}` forwarding the enclosing
 *     component's OWN props (a rest element of, or the whole, first
 *     parameter of a capitalised function). That is a forwarding boundary —
 *     the role enters wherever the component is USED, and that attribute is
 *     read there. `<span {...getErrorProps()}>` has no such later site
 *     (Codex, on #97), which is why "cannot see" is not the exception.
 *   - An identifier is read through the `const` it is bound to, by the
 *     TypeScript checker's symbol rather than by name, so a shadowing
 *     parameter is not mistaken for the outer constant. `const role =
 *     "alert"; const props = { role }` is the shape that needed it (Codex, on
 *     the PR that introduced this scan): the shorthand property was not read
 *     at all, and the spread that applied it was skipped. A `let`, a
 *     parameter, an import or a call stays unreadable.
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
 * The expression a `const` identifier is bound to, or undefined for anything
 * else (a `let`, a parameter, an import, an undeclared name). Resolved by the
 * checker's symbol — the BINDING — so a parameter that shadows an outer
 * constant is the parameter.
 */
type Resolve = (id: ts.Identifier) => ts.Expression | undefined;

function resolverFor(checker: ts.TypeChecker): Resolve {
  return (id) => {
    const parent = id.parent;
    const symbol = parent && ts.isShorthandPropertyAssignment(parent) && parent.name === id
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(id);
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isIdentifier(decl.name)) return undefined;
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return undefined;
    return decl.initializer;
  };
}

/**
 * The values an attribute expression can produce, read from the expressions
 * that produce it: both arms of a ternary, the right of `&&`, either side of
 * `||`/`??`, through parentheses and type assertions, and through a `const`
 * an identifier is bound to. `null`, `undefined` and booleans set no role and
 * read as `null`. Anything else — a `let`, a parameter, a call, a template
 * with a hole — could be any string, and is UNREADABLE.
 */
function valuesOf(node: ts.Node, resolve: Resolve, seen = new Set<ts.Node>()): Value[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return valuesOf(node.expression, resolve, seen);
  if (ts.isConditionalExpression(node)) {
    return [...valuesOf(node.whenTrue, resolve, seen), ...valuesOf(node.whenFalse, resolve, seen)];
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return [null, ...valuesOf(node.right, resolve, seen)];
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return [...valuesOf(node.left, resolve, seen), ...valuesOf(node.right, resolve, seen)];
    }
  }
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword) return [null];
  if (ts.isIdentifier(node)) {
    if (node.text === "undefined") return [null];
    const init = resolve(node);
    // `seen` breaks a cycle of constants naming each other, which parses.
    if (init && !seen.has(init)) {
      seen.add(init);
      return valuesOf(init, resolve, seen);
    }
  }
  return [UNREADABLE];
}

/**
 * The object literals a spread can apply, if the scan can see every one:
 * written in place, or bound to a `const`, through parentheses and type
 * assertions, either arm of a ternary, the right of `&&` (a falsy left adds
 * nothing), and either side of `||`/`??`. `null`, `undefined` and `false`
 * add nothing and contribute no object. Anything else — a call's result, a
 * parameter, a `let` — is undefined: the scan cannot see what it applies.
 */
function objectsOf(node: ts.Expression, resolve: Resolve, seen = new Set<ts.Node>()): ts.ObjectLiteralExpression[] | undefined {
  if (ts.isObjectLiteralExpression(node)) return [node];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return objectsOf(node.expression, resolve, seen);
  const both = (a: ts.Expression, b: ts.Expression) => {
    const left = objectsOf(a, resolve, seen);
    const right = objectsOf(b, resolve, seen);
    return left && right ? [...left, ...right] : undefined;
  };
  if (ts.isConditionalExpression(node)) return both(node.whenTrue, node.whenFalse);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return objectsOf(node.right, resolve, seen);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return both(node.left, node.right);
  }
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return [];
  if (ts.isIdentifier(node)) {
    if (node.text === "undefined") return [];
    const init = resolve(node);
    if (init && !seen.has(init)) {
      seen.add(init);
      return objectsOf(init, resolve, seen);
    }
  }
  return undefined;
}

/** The name a function can be used under as a JSX tag, if it has one. */
function functionName(fn: ts.SignatureDeclaration): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent)
    && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return undefined;
}

/** `param` is the props of a component: the first parameter of a function whose name can be a JSX tag. */
function isComponentProps(param: ts.ParameterDeclaration): boolean {
  const fn = param.parent;
  return ts.isFunctionLike(fn) && fn.parameters[0] === param && /^[A-Z]/.test(functionName(fn) ?? "");
}

/**
 * The spread forwards the enclosing component's OWN props — the whole first
 * parameter, or a rest element destructured from it (in the parameter list,
 * or by a `const` from that parameter). Then the role enters wherever the
 * component is used, and that element's attributes are read there; every
 * spread in this tree is one of these (`Button`, `Card`, the three fields).
 * Anything else the scan cannot see is refused: `<span {...getErrorProps()}>`
 * has no later site where its role is read (Codex, on #97). A component is a
 * function whose name starts with a capital, since only such a name can be a
 * JSX tag; a helper that spreads its parameter is not one.
 */
function forwardsProps(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
    e = e.expression;
  }
  if (!ts.isIdentifier(e)) return false;
  const symbol = checker.getSymbolAtLocation(e);
  const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!decl) return false;
  if (ts.isParameter(decl)) return ts.isIdentifier(decl.name) && isComponentProps(decl);
  if (!ts.isBindingElement(decl) || !decl.dotDotDotToken || !ts.isObjectBindingPattern(decl.parent)) return false;
  const holder = decl.parent.parent;
  if (ts.isParameter(holder)) return isComponentProps(holder);
  if (ts.isVariableDeclaration(holder) && holder.initializer && ts.isIdentifier(holder.initializer)
    && ts.isVariableDeclarationList(holder.parent) && (holder.parent.flags & ts.NodeFlags.Const) !== 0) {
    const source = checker.getSymbolAtLocation(holder.initializer);
    const from = source?.valueDeclaration ?? source?.declarations?.[0];
    return !!from && ts.isParameter(from) && ts.isIdentifier(from.name) && isComponentProps(from);
  }
  return false;
}

/**
 * `createElement(type, props)` — or `cloneElement`, or the automatic
 * runtime's `jsx` — applies `props` exactly as a spread applies its object,
 * so the props are judged with the element's rules (Codex, on #97: `{ role:
 * getRole() }` there was read as a plain object, where an unreadable role is
 * no evidence, while `<span role={getRole()}>` is refused). The DOM's own
 * `document.createElement(tag, options)` takes no props and is not one.
 */
const ELEMENT_FACTORIES = new Set(["createElement", "cloneElement", "jsx", "jsxs", "jsxDEV"]);
function isElementFactory(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return ELEMENT_FACTORIES.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && ELEMENT_FACTORIES.has(callee.name.text)
    && !(ts.isIdentifier(callee.expression) && callee.expression.text === "document");
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
function mayBe(value: ts.Node | undefined, word: string, unreadableCounts: boolean, resolve: Resolve): boolean {
  if (!value) return false;
  return valuesOf(value, resolve).some((v) =>
    v === UNREADABLE ? unreadableCounts : typeof v === "string" && v.trim().toLowerCase() === word);
}

const ERROR_CLASS = /__error(?:--[A-Za-z0-9-]+)?$/;
const hasErrorClass = (s: string) => s.split(/\s+/).some((token) => ERROR_CLASS.test(token));

function tagName(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  return el.tagName.getText();
}

function attrName(name: ts.JsxAttributeName): string | undefined {
  return ts.isIdentifier(name) ? name.text : undefined;
}

/**
 * The names a property can be written under. A computed key is read like a
 * value — `["role"]`, a `const` bound to "role", either arm of a ternary — and
 * one the scan cannot read is UNREADABLE: it could be `role` as easily as
 * anything else (Codex, on #97: `{...{ ["role"]: "alert" }}` passed, because
 * a computed key read as no name at all).
 */
function keysOf(name: ts.PropertyName, resolve: Resolve): (string | typeof UNREADABLE)[] {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    || ts.isNumericLiteral(name)) return [name.text];
  if (ts.isComputedPropertyName(name)) {
    return valuesOf(name.expression, resolve).flatMap((v) => (v === null ? [] : [v]));
  }
  return [];
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  noLib: true,
  noResolve: true,
  target: ts.ScriptTarget.Latest,
  jsx: ts.JsxEmit.Preserve,
  skipLibCheck: true,
  types: [],
};

/**
 * One file, parsed and bound, so an identifier can be followed to its
 * binding. Imports are not resolved (`noResolve`): a local's symbol never
 * crosses a file, which is all this needs — the same shape the
 * discarded-errors gate uses.
 */
function checked(file: string, text: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === file ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => f === file,
    readFile: (f) => (f === file ? text : undefined),
    directoryExists: () => true,
    getDirectories: () => [],
  };
  const checker = ts.createProgram([file], COMPILER_OPTIONS, host).getTypeChecker();
  return { sf, checker };
}

/**
 * Findings for one file, and how many alert roles the visitor inspected on the
 * way — allowed ones included — so the tree test can tell "nothing wrong" from
 * "read nothing".
 */
function scan(file: string, text: string): { findings: Finding[]; alertRoles: number } {
  if (IMPLEMENTATIONS.has(file)) return { findings: [], alertRoles: 0 };
  const { sf, checker } = checked(file, text);
  const resolve = resolverFor(checker);
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
    if (name === "role" && mayBe(value, "alert", jsx, resolve)) {
      alertRoles += 1;
      if (owner !== "StateField") at(site, "role");
    }
    if (name === "aria-live" && mayBe(value, "assertive", jsx, resolve)) at(site, "aria-live");
    if (name === "className" && owner === "FormError" && value) {
      const mark = (n: ts.Node) => {
        formErrorClass.add(n);
        ts.forEachChild(n, mark);
      };
      mark(value);
    }
  };

  // A property of an object literal, under every name its key can be. On an
  // element (`jsx`, a spread) a key the scan cannot read is judged as both
  // `role` and `aria-live`, since it could be either; in a plain object
  // literal it is no evidence of anything, by the same rule that makes only a
  // literal "alert" count there.
  const visitMember = (owner: string | null, name: ts.PropertyName, value: ts.Node, site: ts.Node) => {
    for (const key of keysOf(name, resolve)) {
      if (key !== UNREADABLE) visitProps(owner, key, value, site);
      else if (owner !== null) for (const each of ["role", "aria-live"]) visitProps(owner, each, value, site);
    }
  };

  // A spread applies each property of the object it names as though it were
  // written on the element, so it is judged with the element's rules — a
  // `role` it cannot read is refused there, as `role={r}` is. Nested spreads
  // inside that object are followed too. A getter supplies its value when the
  // object is spread, and the scan cannot read what it returns, so it is
  // unreadable; a method or a setter supplies no string at all. A spread
  // whose objects the scan cannot see could carry either attribute, so it is
  // judged as both — unless it forwards the component's own props.
  const visitSpread = (owner: string, expr: ts.Expression, site: ts.Node, seen = new Set<ts.Node>()) => {
    const objects = objectsOf(expr, resolve);
    if (objects === undefined) {
      if (!forwardsProps(expr, checker)) for (const each of ["role", "aria-live"]) visitProps(owner, each, expr, site);
      return;
    }
    for (const obj of objects) {
      if (seen.has(obj)) continue;
      seen.add(obj);
      for (const prop of obj.properties) {
        if (ts.isPropertyAssignment(prop)) visitMember(owner, prop.name, prop.initializer, site);
        else if (ts.isShorthandPropertyAssignment(prop)) visitProps(owner, prop.name.text, prop.name, site);
        else if (ts.isGetAccessorDeclaration(prop)) visitMember(owner, prop.name, prop, site);
        else if (ts.isSpreadAssignment(prop)) visitSpread(owner, prop.expression, site, seen);
      }
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const owner = tagName(node);
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr)) visitProps(owner, attrName(attr.name), valueOf(attr.initializer), attr);
        else if (ts.isJsxSpreadAttribute(attr)) visitSpread(owner, attr.expression, attr);
      }
    } else if (ts.isCallExpression(node) && isElementFactory(node)) {
      // The element type is the owner (`StateField` may carry the role);
      // an argument list the scan cannot see is props it cannot see.
      const [type, props] = node.arguments;
      const owner = type && (ts.isIdentifier(type) || ts.isStringLiteral(type)) ? type.text : "<element>";
      if (node.arguments.some(ts.isSpreadElement)) {
        for (const each of ["role", "aria-live"]) visitProps("<element>", each, node, node);
      } else if (props) {
        visitSpread(owner, props, node);
      }
    } else if (ts.isPropertyAssignment(node)) {
      visitMember(null, node.name, node.initializer, node);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      // `{ role }`: the value is the binding of the same name.
      visitProps(null, node.name.text, node.name, node);
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
    // Reported where the object is written and where createElement applies
    // it, as a spread's object is.
    expect(rules(`createElement("span", { "aria-live": "assertive" });`)).toEqual(["aria-live", "aria-live"]);
    // An icon called "alert" is not a role, and neither is a signed-in
    // persona: `role` is an ordinary property name outside JSX, so only a
    // literal "alert" there is evidence of anything.
    expect(rules(`const MARKS = { failed: "alert" };`)).toEqual([]);
    expect(rules(`setState({ session, role: null, roleError: null });`)).toEqual([]);
    expect(rules(`const next = { role: resolved.role };`)).toEqual([]);
  });

  it("follows a role through a constant, a shorthand property and a spread (Codex, on #97)", () => {
    // The shape it missed: the shorthand was not read, and the spread that
    // applied it was skipped. Reported where the value is written AND where
    // it is applied.
    expect(rules(`const role = "alert"; const props = { role };
      export const X = () => <span {...props}>x</span>;`)).toEqual(["role", "role"]);
    // A spread is judged as though each property were written on the element,
    // so a role it cannot read is refused there as `role={r}` is.
    expect(rules(`const props = { role: r }; export const X = () => <span {...props}>x</span>;`)).toEqual(["role"]);
    expect(rules(`const base = { role: r }; const props = { ...base };
      export const X = () => <span {...props}>x</span>;`)).toEqual(["role"]);
    expect(rules(`export const X = () => <span {...{ "aria-live": "assertive" }}>x</span>;`))
      .toEqual(["aria-live", "aria-live"]);
    expect(rules(`const r = "alert"; export const X = () => <span role={r}>x</span>;`)).toEqual(["role"]);
  });

  it("reads a computed key like a value, and refuses one it cannot read on an element (Codex, on #97)", () => {
    // The shape it missed: a computed key read as no name at all.
    expect(rules(`export const X = () => <span {...{ ["role"]: "alert" }}>x</span>;`)).toEqual(["role", "role"]);
    expect(rules(`const k = "role"; const props = { [k]: "alert" };
      export const X = () => <span {...props}>x</span>;`)).toEqual(["role", "role"]);
    expect(rules(`const props = { [\`aria-live\`]: "assertive" }; export const X = () => <b {...props} />;`))
      .toEqual(["aria-live", "aria-live"]);
    // A key it cannot read could be role or aria-live, so on an element it is
    // judged as both — refused when its value could be an alert region…
    expect(rules(`const props = { [k]: v }; export const X = () => <span {...props}>x</span>;`))
      .toEqual(["role", "aria-live"]);
    // …and admitted when the value cannot be one, whatever the key is.
    expect(rules(`const props = { [k]: "status" }; export const X = () => <span {...props}>x</span>;`)).toEqual([]);
    // In a plain object literal an unreadable key is no evidence of anything:
    // a lookup table keyed by a variable is ordinary code.
    expect(rules(`const MARKS = { [status]: "alert" };`)).toEqual([]);
    // A getter supplies its value when the object is spread, and the scan
    // cannot read what it returns.
    expect(rules(`const props = { get role() { return r; } }; export const X = () => <span {...props}>x</span>;`))
      .toEqual(["role"]);
    expect(rules(`const props = { role() { return 1; } }; export const X = () => <span {...props}>x</span>;`))
      .toEqual([]);
  });

  it("refuses a spread it cannot see, unless it forwards the component's own props (Codex, on #97)", () => {
    // The shape it admitted: an opaque spread straight onto a DOM element,
    // which has no later site where the role it carries is read.
    expect(rules(`export const X = () => <span {...getErrorProps()}>x</span>;`)).toEqual(["role", "aria-live"]);
    expect(rules(`export const X = ({ p }) => <span {...p}>x</span>;`)).toEqual(["role", "aria-live"]);
    expect(rules(`let p = {}; export const X = () => <Card {...p}>x</Card>;`)).toEqual(["role", "aria-live"]);
    // StateField may carry the role, but not an assertive live region.
    expect(rules(`export const X = () => <StateField {...getProps()} title="x" />;`)).toEqual(["aria-live"]);
    // What the scan can see is judged, not refused: both arms, the right of
    // &&, and a spread of nothing.
    expect(rules(`const a = { role: "status" }; const b = { title: "x" };
      export const X = ({ big }) => <span {...(big ? a : b)}>x</span>;`)).toEqual([]);
    expect(rules(`const a = { role: "status" }; export const X = ({ on }) => <span {...(on && a)}>x</span>;`)).toEqual([]);
    expect(rules(`export const X = () => <span {...null}>x</span>;`)).toEqual([]);
    expect(rules(`const a = { role: r }; export const X = ({ big }) => <span {...(big ? a : {})}>x</span>;`))
      .toEqual(["role"]);
  });

  it("admits a component forwarding its own props, and nothing that merely looks like it", () => {
    // Every spread in the tree is this shape: a rest element of the first
    // parameter of a capitalised function.
    expect(rules(`export function Card({ className, ...rest }) { return <div {...rest} />; }`)).toEqual([]);
    expect(rules(`export function Card(props) { return <div {...props} />; }`)).toEqual([]);
    expect(rules(`export const Card = ({ className, ...rest }) => <div {...rest} />;`)).toEqual([]);
    expect(rules(`export function Card(props) { const { className, ...rest } = props; return <div {...rest} />; }`))
      .toEqual([]);
    // A helper is not a component: nothing reads its caller's attributes.
    expect(rules(`function render({ ...p }) { return <span {...p} />; }`)).toEqual(["role", "aria-live"]);
    // Nor is a second parameter, a nested rest, or a rest of something else.
    expect(rules(`export function Card(props, extra) { return <div {...extra} />; }`)).toEqual(["role", "aria-live"]);
    expect(rules(`export function Card({ a: { ...inner } }) { return <div {...inner} />; }`)).toEqual(["role", "aria-live"]);
    expect(rules(`export function Card(props) { const { ...rest } = getProps(); return <div {...rest} />; }`))
      .toEqual(["role", "aria-live"]);
  });

  it("judges createElement's props with the element's rules (Codex, on #97)", () => {
    // The shape it admitted: an unreadable role in a props object, read as a
    // plain object where an unreadable role is no evidence.
    expect(rules(`createElement("span", { role: getRole() });`)).toEqual(["role"]);
    expect(rules(`React.createElement("span", { role: r });`)).toEqual(["role"]);
    expect(rules(`cloneElement(child, { "aria-live": level });`)).toEqual(["aria-live"]);
    expect(rules(`jsx("span", { role: r });`)).toEqual(["role"]);
    // Props it cannot see, or an argument list it cannot see.
    expect(rules(`React.createElement("span", getProps());`)).toEqual(["role", "aria-live"]);
    expect(rules(`createElement(...args);`)).toEqual(["role", "aria-live"]);
    // The element type is the owner, and forwarding is forwarding here too.
    expect(rules(`createElement(StateField, { role: r, title: "x" });`)).toEqual([]);
    expect(rules(`export function Wrap(props) { return createElement("span", props); }`)).toEqual([]);
    // The DOM's own createElement takes no props.
    expect(rules(`const a = document.createElement("a");`)).toEqual([]);
    expect(rules(`const el = document.createElement("div", options);`)).toEqual([]);
    expect(rules(`createElement("span", { role: "status" }, "x");`)).toEqual([]);
  });

  it("admits what a binding says is harmless, and a forwarded spread", () => {
    expect(rules(`const r = "status"; export const X = () => <span role={r}>x</span>;`)).toEqual([]);
    expect(rules(`const props = { role: "status" }; export const X = () => <span {...props}>x</span>;`)).toEqual([]);
    // A component forwarding its own props: the role is read where it is used.
    expect(rules(`export function Card({ children, ...rest }) { return <div {...rest}>{children}</div>; }`))
      .toEqual([]);
    // StateField may carry it however it arrives.
    expect(rules(`const props = { role: r }; export const X = () => <StateField {...props} title="x" />;`))
      .toEqual([]);
  });

  it("resolves by binding, not by name", () => {
    // The parameter shadows the constant, so this `{ role }` is a persona.
    expect(rules(`const role = "alert";
      export function persona(role: string | null) { return { role }; }`)).toEqual([]);
    // A `let` can be reassigned before it is read, so it stays unreadable —
    // and on an element, unreadable is refused.
    expect(rules(`let r = "status"; export const X = () => <span role={r}>x</span>;`)).toEqual(["role"]);
    // Constants naming each other parse; the scan must not loop.
    expect(rules(`const a = b; const b = a; export const X = () => <span role={a}>x</span>;`)).toEqual(["role"]);
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
