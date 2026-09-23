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
 *     caught where it is written, not only where it is applied, and so is a
 *     class assembled by concatenation (`"signin__" + "error"`, a template
 *     built from constants) — `+` and templates are folded through the
 *     constants the scan can read, and reported once, at the innermost
 *     concatenation that forms the class. What it cannot compute (a
 *     parameter, a call) stays unread, as it does for a role. The one
 *     exception is `FormError`'s own `className` prop, which layers a layout
 *     class onto the region (`claim-invite__error`) rather than building one.
 *   - Object literals are read as well as JSX (`{ role: "alert" }`), since
 *     `<span {...props}>` and `createElement` carry props that way — and so is
 *     the spread itself. A spread whose object the scan can see (a literal,
 *     or a `const` bound to one, either arm of a ternary) is read as though
 *     each of its properties were written on the element, so `{ role: r }`
 *     spread onto a `<span>` is refused exactly as `<span role={r}>` is.
 *     `createElement`'s props (and `cloneElement`'s, and the automatic
 *     runtime's `jsx`) are applied exactly as a spread is, and judged so —
 *     however the factory is reached: every REFERENCE to one is judged, and
 *     one the scan cannot see being called is refused where it is taken
 *     (`factoryCall`, below).
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
  note?: string; // why a site that is not an attribute was judged as one
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
 *
 * Every REFERENCE to a factory is judged, not only the calls the scan
 * recognises, because a factory it does not see being called applies props
 * it never reads (Codex again: `React["createElement"](…)` passed). So the
 * member is read however it is spelled — `.createElement`,
 * `["createElement"]`, a template, a `const` key — and through parentheses,
 * assertions and a comma (`(0, React.createElement)(…)`); a CALL through a
 * member the scan cannot read could be a factory, and is judged as one; and a
 * factory referenced without being called (`const h = React.createElement`,
 * handed to a function, `.call`) or taken under another name (`import {
 * createElement as h }`, `const { createElement: h } = React`, a key the scan
 * cannot read, a destructuring assignment) is refused where it is taken,
 * since its calls are under a name the scan does not follow.
 *
 * A bare name is the factory when it is imported, destructured in a variable
 * declaration, or not declared in the file at all. A local variable,
 * function, class or parameter of the same name is something else — a
 * destructured parameter is a component's props — and the factory could only
 * reach one through a reference refused where it is taken. What stays
 * outside: a factory reached without its name appearing in the tree, as an
 * unreadable member taken as a value (indexing that is not called is ordinary
 * code) or a library that applies props itself.
 */
const ELEMENT_FACTORIES = new Set(["createElement", "cloneElement", "jsx", "jsxs", "jsxDEV"]);
const isFactoryName = (n: string | typeof UNREADABLE): boolean => typeof n === "string" && ELEMENT_FACTORIES.has(n);

/** Parentheses, assertions and non-null: nodes that hand their value on unchanged. */
const passesThrough = (n: ts.Node): n is
  ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression | ts.NonNullExpression | ts.TypeAssertion =>
  ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)
  || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n);

const isComma = (n: ts.Node): n is ts.BinaryExpression =>
  ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken;

/** What a call calls: through the pass-throughs and a comma's right side. */
function calleeOf(call: ts.CallExpression): ts.Expression {
  let e: ts.Expression = call.expression;
  for (;;) {
    if (passesThrough(e)) e = e.expression;
    else if (isComma(e)) e = e.right;
    else return e;
  }
}

/** The call `node` is what calls, climbing the same nodes `calleeOf` descends. */
function callOf(node: ts.Node): ts.CallExpression | undefined {
  let e = node;
  for (let p = e.parent; p; e = p, p = e.parent) {
    if (!((passesThrough(p) && p.expression === e) || (isComma(p) && p.right === e))) {
      return ts.isCallExpression(p) && p.expression === e ? p : undefined;
    }
  }
  return undefined;
}

/**
 * The names a member access can read, the way a computed key is read in
 * `keysOf`: `.x`, `["x"]`, `` [`x`] ``, a `const` key, either arm of a
 * ternary, and UNREADABLE for a key the scan cannot read.
 */
function memberNames(access: ts.PropertyAccessExpression | ts.ElementAccessExpression, resolve: Resolve): (string | typeof UNREADABLE)[] {
  if (ts.isPropertyAccessExpression(access)) return [access.name.text];
  if (ts.isNumericLiteral(access.argumentExpression)) return [access.argumentExpression.text];
  return valuesOf(access.argumentExpression, resolve).flatMap((v) => (v === null ? [] : [v]));
}

/** A member access names a factory, could (its key is unreadable), or does not. */
function memberFactory(access: ts.PropertyAccessExpression | ts.ElementAccessExpression, resolve: Resolve): "factory" | "maybe" | undefined {
  if (ts.isIdentifier(access.expression) && access.expression.text === "document") return undefined;
  const names = memberNames(access, resolve);
  if (names.some(isFactoryName)) return "factory";
  return names.includes(UNREADABLE) ? "maybe" : undefined;
}

/** The declaration a name is bound by, reading a shorthand property as the value it names. */
function bindingOf(id: ts.Identifier, checker: ts.TypeChecker): ts.Declaration | undefined {
  const p = id.parent;
  const symbol = p && ts.isShorthandPropertyAssignment(p) && p.name === id
    ? checker.getShorthandAssignmentValueSymbol(p)
    : checker.getSymbolAtLocation(id);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

/** A bare name is the factory: imported, destructured in a variable declaration, or not declared here at all. */
function namesFactory(id: ts.Identifier, checker: ts.TypeChecker): boolean {
  if (!ELEMENT_FACTORIES.has(id.text)) return false;
  const decl = bindingOf(id, checker);
  if (!decl) return true;
  if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) return true;
  let holder: ts.Node = decl;
  while (ts.isBindingElement(holder)) holder = holder.parent.parent;
  return holder !== decl && ts.isVariableDeclaration(holder);
}

/**
 * The name is read as a value here — not declared, not a member's name (the
 * access is judged instead), not the source of a rename (judged as the
 * rename), not in a type, and not the target of a destructuring assignment.
 */
function isValueReference(id: ts.Identifier, checker: ts.TypeChecker): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isShorthandPropertyAssignment(p)) return p.name === id && !isAssignmentTarget(p.parent);
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isBindingElement(p)) && p.propertyName === id) return false;
  if (ts.isExportSpecifier(p)) return false;
  for (let a: ts.Node | undefined = p; a && !ts.isSourceFile(a); a = a.parent) if (ts.isTypeNode(a)) return false;
  const symbol = checker.getSymbolAtLocation(id);
  return !symbol?.declarations?.some((d) => (d as ts.NamedDeclaration).name === id);
}

/**
 * `node` is being assigned to: the left of `=`, or inside a literal that is —
 * so `({ createElement } = React)` takes the member out without a binding
 * pattern the scan would read as one.
 */
function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node;
  if (ts.isParenthesizedExpression(parent)) return isAssignmentTarget(parent);
  if ((ts.isPropertyAssignment(parent) && parent.initializer === node) || ts.isSpreadAssignment(parent)
    || ts.isSpreadElement(parent)) return isAssignmentTarget(parent.parent);
  if (ts.isArrayLiteralExpression(parent)) return isAssignmentTarget(parent);
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === node;
  return false;
}

/** The text of an import or export name, which may be an identifier or a string. */
const exportNameText = (n: ts.ModuleExportName): string => n.text;

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

/** A `+` or a template: where a string is assembled from pieces. */
const isCombiner = (node: ts.Node): boolean =>
  ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);

/** Past this many values a fold gives up rather than multiply ternaries without bound. */
const FOLD_LIMIT = 64;

interface Fold {
  values: string[]; // every string the expression can produce
  literals: string[]; // every literal piece the fold read, wherever it is written
  combiners: ts.Node[]; // every `+` or template it passed through, itself included
}

/**
 * The strings an expression can produce, when the scan can compute every one:
 * a string literal, `+` over strings, a template whose holes it can compute,
 * either arm of a ternary, through parentheses and type assertions and a
 * `const` an identifier is bound to. Undefined for anything else — a
 * parameter, a call, a number, a `let` — which is the same line `valuesOf`
 * draws, and past FOLD_LIMIT values.
 */
function foldOf(node: ts.Node, resolve: Resolve, path: Set<ts.Node> = new Set()): Fold | undefined {
  const piece = (s: string): Fold => ({ values: [s], literals: [s], combiners: [] });
  const join = (a: Fold | undefined, b: Fold | undefined): Fold | undefined =>
    !a || !b || a.values.length * b.values.length > FOLD_LIMIT ? undefined : {
      values: a.values.flatMap((x) => b.values.map((y) => x + y)),
      literals: [...a.literals, ...b.literals],
      combiners: [...a.combiners, ...b.combiners],
    };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return piece(node.text);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return foldOf(node.expression, resolve, path);
  if (ts.isConditionalExpression(node)) {
    const a = foldOf(node.whenTrue, resolve, path);
    const b = foldOf(node.whenFalse, resolve, path);
    return a && b && a.values.length + b.values.length <= FOLD_LIMIT ? {
      values: [...a.values, ...b.values],
      literals: [...a.literals, ...b.literals],
      combiners: [...a.combiners, ...b.combiners],
    } : undefined;
  }
  if (ts.isIdentifier(node)) {
    // The path rather than every node visited: a constant used twice is read
    // twice, and only one that leads back to itself (which parses) is refused.
    const init = resolve(node);
    return init && !path.has(init) ? foldOf(init, resolve, new Set([...path, init])) : undefined;
  }
  let folded: Fold | undefined;
  if (ts.isTemplateExpression(node)) {
    folded = piece(node.head.text);
    for (const span of node.templateSpans) folded = join(join(folded, foldOf(span.expression, resolve, path)), piece(span.literal.text));
  } else if (isCombiner(node)) {
    const bin = node as ts.BinaryExpression;
    folded = join(foldOf(bin.left, resolve, path), foldOf(bin.right, resolve, path));
  }
  return folded && { ...folded, combiners: [...folded.combiners, node] };
}

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
  const at = (node: ts.Node, rule: Finding["rule"], note?: string) =>
    findings.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      rule,
      text: node.getText(sf).replace(/\s+/g, " ").slice(0, 100),
      ...(note ? { note } : {}),
    });
  // A factory the scan cannot follow could apply either attribute.
  const refuse = (site: ts.Node, note: string) => {
    at(site, "role", note);
    at(site, "aria-live", note);
  };
  const TAKEN = "an element factory taken as a value, so the scan cannot see the props it is called with";
  const RENAMED = "an element factory taken under another name, so the scan cannot see its calls";
  const UNREAD_KEY = "a member taken by destructuring under a key the scan cannot read, which could be an element factory";
  const ASSIGNED = "an element factory taken by destructuring assignment into a variable declared elsewhere, so the scan cannot see its calls";
  const factoryCall = (call: ts.CallExpression): "factory" | "maybe" | undefined => {
    const callee = calleeOf(call);
    if (ts.isIdentifier(callee)) return namesFactory(callee, checker) ? "factory" : undefined;
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) return memberFactory(callee, resolve);
    return undefined;
  };

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
    } else if (ts.isCallExpression(node) && factoryCall(node)) {
      // The element type is the owner when it names a component
      // (`StateField` may carry the role, `FormError` its className); a
      // string type is a host element whatever it spells, so
      // `createElement("StateField", …)` takes neither exemption (Codex, on
      // #97). An argument list the scan cannot see is props it cannot see.
      const before = findings.length;
      const [type, props] = node.arguments;
      const owner = type && ts.isIdentifier(type) ? type.text : "<element>";
      if (node.arguments.some(ts.isSpreadElement)) {
        for (const each of ["role", "aria-live"]) visitProps("<element>", each, node, node);
      } else if (props) {
        visitSpread(owner, props, node);
      }
      if (factoryCall(node) === "maybe") {
        for (const f of findings.slice(before)) f.note = "a call through a member the scan cannot read, judged as the element factory it could be";
      }
    } else if (ts.isPropertyAssignment(node)) {
      visitMember(null, node.name, node.initializer, node);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      // `{ role }`: the value is the binding of the same name.
      visitProps(null, node.name.text, node.name, node);
    }

    // A factory referenced without being called, however it is spelled.
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && memberFactory(node, resolve) === "factory" && !callOf(node)) refuse(node, TAKEN);
    if (ts.isIdentifier(node) && ELEMENT_FACTORIES.has(node.text) && isValueReference(node, checker)
      && namesFactory(node, checker) && !callOf(node)) refuse(node, TAKEN);
    // A factory taken under another name: renamed on import or export, or
    // destructured under another key, or under a key the scan cannot read.
    if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && node.propertyName
      && ELEMENT_FACTORIES.has(exportNameText(node.propertyName)) && exportNameText(node.propertyName) !== node.name.text) {
      refuse(node, RENAMED);
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken && node.propertyName) {
      const keys = keysOf(node.propertyName, resolve);
      const local = ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (keys.some((k) => isFactoryName(k) && k !== local)) refuse(node, RENAMED);
      else if (keys.includes(UNREADABLE)) refuse(node, UNREAD_KEY);
    }
    // `({ createElement } = React)`: taken into a variable declared elsewhere.
    if ((ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) && isAssignmentTarget(node.parent)) {
      const keys = keysOf(node.name, resolve);
      if (keys.some(isFactoryName)) refuse(node, ASSIGNED);
      else if (keys.includes(UNREADABLE)) refuse(node, UNREAD_KEY);
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

  // A class assembled by concatenation is assembled where it is written:
  // `"signin__" + "error"` carries it in neither literal, and a BEM class
  // built from constants, `${BLOCK}__${ELEMENT}`, in none (Codex, on #97).
  // So every `+` and template is folded, and a class that appears only in the
  // fold is reported ONCE, at the innermost combiner that forms it: a class a
  // single literal already carries is that literal's finding above, and a
  // combiner built on another that already formed it adds nothing new.
  const folds = new Map<ts.Node, Fold | undefined>();
  const fold = (n: ts.Node) => {
    if (!folds.has(n)) folds.set(n, foldOf(n, resolve));
    return folds.get(n);
  };
  const forms = (n: ts.Node): boolean => {
    const f = fold(n);
    return !!f && f.values.some(hasErrorClass) && !f.literals.some(hasErrorClass);
  };
  const combiners = (node: ts.Node) => {
    if (isCombiner(node) && !formErrorClass.has(node) && forms(node)
      && !fold(node)!.combiners.some((c) => c !== node && forms(c))) {
      at(node, "error-class");
    }
    ts.forEachChild(node, combiners);
  };
  combiners(sf);
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
  fs.map((f) => `  ${f.file}:${f.line} [${f.rule}] ${f.text}${f.note ? ` — ${f.note}` : ""}`).join("\n");

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

  it("refuses an __error class assembled by concatenation, where it is assembled (Codex, on #97)", () => {
    // The shape it missed: neither fragment carries the class on its own.
    expect(rules(`const cls = "signin__" + "error"; export const X = () => <span className={cls}>x</span>;`))
      .toEqual(["error-class"]);
    // The good-faith shape: a BEM class built from constants.
    expect(rules("const BLOCK = \"signin\"; const ELEMENT = \"error\"; const cls = `${BLOCK}__${ELEMENT}`;"))
      .toEqual(["error-class"]);
    expect(rules(`const cls = "x__" + (big ? "error--big" : "error");`)).toEqual(["error-class"]);
    expect(rules(`const ERR = "error"; const cls = "a__" + ERR + " " + "b__" + ERR;`)).toEqual(["error-class"]);
    // A constant read twice in one concatenation is read twice: only a
    // constant that leads back to itself stops the fold.
    expect(rules(`const E = "error"; const cls = E + " x__" + E;`)).toEqual(["error-class"]);
    // Reported once, where it is formed — not again by everything that uses it.
    expect(rules(`const cls = "signin__" + "error"; const wide = cls + " wide";`)).toEqual(["error-class"]);
    expect(rules(`const cls = "signin__error" + " wide";`)).toEqual(["error-class"]);
    // What the scan cannot compute stays unread, and a healthy class is healthy.
    expect(rules(`const cls = "signin__" + kind;`)).toEqual([]);
    expect(rules(`const cls = "walk-card__" + "error-count";`)).toEqual([]);
    expect(rules("const cls = `walk-card__${state}`;")).toEqual([]);
    // FormError's own className may still carry it, however it is assembled.
    expect(rules(`<FormError message={e} className={"claim-invite__" + "error"} />`)).toEqual([]);
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

  it("reads an element factory however it is reached (Codex, on #97)", () => {
    // The shape it missed: a factory called through a computed member.
    expect(rules(`React["createElement"]("span", { role: getRole() });`)).toEqual(["role"]);
    expect(rules("React[`createElement`](\"span\", { role: r });")).toEqual(["role"]);
    expect(rules(`const K = "cloneElement"; React[K](child, { role: r });`)).toEqual(["role"]);
    // Through parentheses, an assertion and a comma, as a bundler writes it.
    expect(rules(`(0, React.createElement)("span", { role: r });`)).toEqual(["role"]);
    expect(rules(`(React.createElement as Factory)("span", { role: r });`)).toEqual(["role"]);
    // A call through a member it cannot read could be one, and is judged so…
    expect(rules(`React[name]("span", { role: r });`)).toEqual(["role"]);
    expect(rules(`React[name]("span", getProps());`)).toEqual(["role", "aria-live"]);
    expect(scanSource("screens/Probe.tsx", `React[name]("span", { role: r });`)[0]?.note)
      .toMatch(/cannot read, judged as the element factory it could be/);
    // …which clears whatever it is when nothing in it could be an alert.
    expect(rules(`handlers[kind]("span", { title: "x" });`)).toEqual([]);
    // The DOM's is not one, however it is spelled.
    expect(rules(`document["createElement"]("div", options);`)).toEqual([]);
    expect(rules(`document[name]("div", options);`)).toEqual([]);
  });

  it("refuses an element factory taken as a value or under another name (Codex, on #97)", () => {
    const both = ["role", "aria-live"];
    const notes = (text: string) => scanSource("screens/Probe.tsx", text).map((f) => f.note);
    // Its calls are under a name the scan does not follow.
    expect(rules(`const h = React.createElement;`)).toEqual(both);
    expect(rules(`const h = React["cloneElement"];`)).toEqual(both);
    expect(rules(`React.createElement.call(null, "span", { role: r });`)).toEqual(both);
    expect(rules(`import { createElement } from "react"; export const h = createElement;`)).toEqual(both);
    expect(rules(`render(jsx);`)).toEqual(both);
    expect(rules(`import { createElement } from "react"; const f = { createElement };`)).toEqual(both);
    expect(notes(`const h = React.createElement;`)[0]).toMatch(/taken as a value/);
    expect(rules(`import { createElement as h } from "react";`)).toEqual(both);
    expect(rules(`export { createElement as h } from "react";`)).toEqual(both);
    expect(rules(`const { createElement: h } = React;`)).toEqual(both);
    expect(rules(`const { ["cloneElement"]: c } = React;`)).toEqual(both);
    expect(notes(`const { createElement: h } = React;`)[0]).toMatch(/under another name/);
    expect(rules(`const { [key]: h } = React;`)).toEqual(both);
    expect(notes(`const { [key]: h } = React;`)[0]).toMatch(/key the scan cannot read/);
    expect(rules(`let createElement; ({ createElement } = React);`)).toEqual(both);
    expect(notes(`let createElement; ({ createElement } = React);`)[0]).toMatch(/declared elsewhere/);
    // Under its own name it is still read where it is called.
    expect(rules(`import { createElement } from "react"; createElement("span", { role: "status" });`)).toEqual([]);
    expect(rules(`const { createElement } = React; createElement("span", { role: r });`)).toEqual(["role"]);
    expect(rules(`const { createElement: createElement } = React;`)).toEqual([]);
    expect(rules(`export { createElement } from "react";`)).toEqual([]);
    // A local of the same name is something else, and a type is no reference.
    expect(rules(`const jsx = compile(md); export const X = () => <div>{jsx}</div>;`)).toEqual([]);
    expect(rules(`export function Card({ jsx }) { return <div>{jsx}</div>; }`)).toEqual([]);
    expect(rules(`type F = typeof React.createElement; let g: typeof createElement;`)).toEqual([]);
    // …and a wrapper of the real one is caught where it applies the props.
    expect(rules(`function make(tag, props) { return React.createElement(tag, props); }`)).toEqual(both);
  });

  it("gives a component's exemption only to the component, never to a string (Codex, on #97)", () => {
    // A string element type is a host element, whatever it spells: the
    // StateField exemption for the role…
    expect(rules(`createElement("StateField", { role: getRole() });`)).toEqual(["role"]);
    expect(rules(`createElement("StateField", { role: "alert" });`)).toEqual(["role", "role"]);
    // …and FormError's for its className, the sibling.
    expect(rules(`createElement("FormError", { className: "x__error" });`)).toEqual(["error-class"]);
    // The components themselves keep them.
    expect(rules(`createElement(StateField, { role: getRole() });`)).toEqual([]);
    expect(rules(`createElement(FormError, { message: m, className: "claim-invite__error" });`)).toEqual([]);
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
