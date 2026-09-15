import ts from "typescript";

/**
 * Reading STATIC OBJECT SHAPES out of TypeScript, for the gates that need to
 * know what a literal actually carries.
 *
 * Two gates ask that question — `form-error.test.ts` about a JSX attribute,
 * `realtime-channel.test.ts` about a broadcast message and a channel's
 * `config` — and they kept diverging. Three consecutive Codex rounds on PR #94
 * were the same finding: a rule present in one reader and absent from the
 * other, once in each direction (a declared identifier the JSX side would not
 * follow; a transparent `as const` the channel side would not unwrap; then a
 * `let` reassignment neither refused). Patching whichever side is pointed at
 * is the per-site disease this repository's log records more than any other,
 * so the PRIMITIVES live here, in one implementation, and there is no sibling
 * to forget.
 *
 * What stays in each gate is the part that genuinely differs: the shape of an
 * answer. The JSX reader distinguishes "absent" (leave an earlier answer
 * standing) from "present but dynamic" (replace it with no answer); the
 * channel reader carries nodes and markers so it can recurse into `config`
 * and print what it could not read. Those are different questions and share
 * nothing but these building blocks.
 *
 * Stated limit, on the stopping rule the enum-catalogue generator writes down:
 * this catches the mistake, not the adversary. Nothing here follows a value
 * across a module boundary, through a function call, or into a computed
 * member, and a value it cannot read is reported as unreadable rather than
 * guessed at.
 */

/**
 * `as`, `satisfies`, parentheses and `!` hand the same value through.
 *
 * React receives the same literal through every one of them and so does
 * Realtime, so a reader that stops at the wrapper either calls a static value
 * dynamic (a miss) or calls a private option non-private (a gate red on a
 * healthy tree, which is the worse of the two).
 */
export function unwrapTransparent(e: ts.Expression): ts.Expression {
  let cur = e;
  for (let i = 0; i < 8; i += 1) {
    if (
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
  return cur;
}

/** The text of a statically readable string, or null for a dynamic one. */
export function literalText(e: ts.Expression): string | null {
  const cur = unwrapTransparent(e);
  if (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur)) return cur.text;
  return null;
}

/**
 * A property's name when the compiler can read it, or null when it cannot.
 *
 * A COMPUTED key whose expression is a string literal is fully static and
 * names exactly one property: `{ ["role"]: "alert" }` is the same object as
 * `{ role: "alert" }`. A key that is genuinely an expression stays null, which
 * every caller must read as "could be the name I am asking about".
 */
export function propertyKey(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) return literalText(name.expression);
  return null;
}

/**
 * The object literals a name reliably holds, for a spread to resolve.
 *
 * Two rules, each arrived at the hard way:
 *
 *  - a name bound MORE THAN ONCE, anywhere and by any binding form, is
 *    unresolvable. A file-global map does not merely miss a shadowed binding,
 *    it answers confidently and WRONGLY, which is worse — and the first
 *    version of that rule counted variable declarations alone, so the very
 *    first binding form that is not `const` (a function parameter) walked past
 *    it;
 *  - a name that is ASSIGNED anywhere is unresolvable, whatever it was
 *    initialised to. `let attrs = { role: "status" }; attrs = { role: "alert" }`
 *    is a stale initializer, the same shape as reading a literal that has
 *    since been mutated. "Assigned" means every form, not the one spelling
 *    that came first: `x = …`, every compound operator, `x++`, a destructuring
 *    target, a `for (x of …)` or `for (x in …)` loop variable, AND a mutation
 *    of what it holds — `x.y = …`, `x["y"] = …`, `delete x.y`,
 *    `Object.assign(x, …)`. The object is what the caller reads, so changing
 *    the object is changing the answer just as much as rebinding the name.
 *
 * Both are refusals rather than analyses, which is the stopping rule this
 * repository settled on: an ambiguous name never gets a confident answer, and
 * the remedy — rename one, or use `const` — is cheaper than a Program over
 * the whole app for this question.
 */
export function declaredObjects(sf: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const seen = new Map<string, ts.ObjectLiteralExpression | null>();
  const assigned = new Set<string>();

  const bind = (name: string, lit: ts.ObjectLiteralExpression | null) => {
    seen.set(name, seen.has(name) ? null : lit);
  };
  const bindPattern = (nm: ts.BindingName): void => {
    if (ts.isIdentifier(nm)) {
      bind(nm.text, null);
      return;
    }
    for (const el of nm.elements) if (ts.isBindingElement(el)) bindPattern(el.name);
  };

  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name)) {
        const init = n.initializer ? unwrapTransparent(n.initializer) : undefined;
        bind(n.name.text, init && ts.isObjectLiteralExpression(init) ? init : null);
      } else bindPattern(n.name);
    } else if (ts.isParameter(n) || ts.isBindingElement(n)) {
      bindPattern(n.name);
    } else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) {
      bind(n.name.text, null);
    } else if (ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n)) {
      if (n.name && ts.isIdentifier(n.name)) bind(n.name.text, null);
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      bindPattern(n.variableDeclaration.name);
    }

    // Rebinding the NAME: `x = …`, every compound form, and `x++`. A
    // destructuring assignment target counts too.
    if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind)) {
      collectAssignmentTargets(n.left, assigned);
    }
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(n.operand)
    ) {
      assigned.add(n.operand.text);
    }
    // A loop variable is assigned on every iteration and produces no
    // BinaryExpression at all, so `for (x of […])` slipped past the rule above.
    // Only the bare-identifier form matters: `for (const x of …)` declares a
    // fresh binding, which the declaration branch already sees.
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
      collectAssignmentTargets(n.initializer, assigned);
    }
    // And MUTATING what the name holds. The caller reads the object, so
    // `channelConfig.private = false` changes the answer exactly as rebinding
    // the name would — and the first version of this rule watched only the
    // rebinding, which is the same half-a-rule the property-mutation check in
    // the channel gate had before it (Codex, PR #94).
    if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind)) {
      collectMutatedRoots(n.left, assigned);
    }
    if (ts.isDeleteExpression(n)) collectMutatedRoots(n.expression, assigned);
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "assign"
    ) {
      // `Object.assign(target, …)` writes into its FIRST argument.
      const target = n.arguments[0];
      if (target) collectMutatedRoots(target, assigned, true);
    }

    ts.forEachChild(n, visit);
  };
  visit(sf);

  const out = new Map<string, ts.ObjectLiteralExpression>();
  for (const [name, lit] of seen) if (lit && !assigned.has(name)) out.set(name, lit);
  return out;
}

/** Every assignment operator, `=` and the compound ones alike. */
export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    (kind >= ts.SyntaxKind.FirstCompoundAssignment && kind <= ts.SyntaxKind.LastCompoundAssignment)
  );
}

/**
 * The identifier at the ROOT of a member chain, when the chain is being
 * written to — `a.b.c = x`, `a["b"] = x`, `delete a.b`, `Object.assign(a, …)`.
 *
 * `direct` is for the `Object.assign` case, where the target is the object
 * itself rather than a member of it.
 */
function collectMutatedRoots(e: ts.Expression, into: Set<string>, direct = false): void {
  let cur: ts.Expression = unwrapTransparent(e);
  if (!direct) {
    if (!ts.isPropertyAccessExpression(cur) && !ts.isElementAccessExpression(cur)) return;
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = unwrapTransparent(cur.expression);
    }
  }
  if (ts.isIdentifier(cur)) into.add(cur.text);
}

/** The identifiers an assignment's left-hand side writes to. */
function collectAssignmentTargets(left: ts.Expression, into: Set<string>): void {
  const target = unwrapTransparent(left);
  if (ts.isIdentifier(target)) {
    into.add(target.text);
    return;
  }
  if (ts.isObjectLiteralExpression(target)) {
    for (const p of target.properties) {
      if (ts.isShorthandPropertyAssignment(p)) into.add(p.name.text);
      else if (ts.isPropertyAssignment(p)) collectAssignmentTargets(p.initializer, into);
      else if (ts.isSpreadAssignment(p)) collectAssignmentTargets(p.expression, into);
    }
    return;
  }
  if (ts.isArrayLiteralExpression(target)) {
    for (const el of target.elements) {
      if (ts.isSpreadElement(el)) collectAssignmentTargets(el.expression, into);
      else collectAssignmentTargets(el, into);
    }
  }
}
